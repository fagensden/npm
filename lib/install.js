'use strict'
// npm install <pkg> <pkg> <pkg>
//
// See doc/install.md for more description

// Managing contexts...
// there's a lot of state associated with an "install" operation, including
// packages that are already installed, parent packages, current shrinkwrap, and
// so on. We maintain this state in a "context" object that gets passed around.
// every time we dive into a deeper node_modules folder, the "family" list that
// gets passed along uses the previous "family" list as its __proto__.  Any
// "resolved precise dependency" things that aren't already on this object get
// added, and then that's passed to the next generation of installation.

module.exports = install
module.exports.Installer = Installer

install.usage = 'npm install'
              + '\nnpm install <pkg>'
              + '\nnpm install <pkg>@<tag>'
              + '\nnpm install <pkg>@<version>'
              + '\nnpm install <pkg>@<version range>'
              + '\nnpm install <folder>'
              + '\nnpm install <tarball file>'
              + '\nnpm install <tarball url>'
              + '\nnpm install <git:// url>'
              + '\nnpm install <github username>/<github project>'
              + '\n\nCan specify one or more: npm install ./foo.tgz bar@stable /some/folder'
              + '\nIf no argument is supplied and ./npm-shrinkwrap.json is '
              + '\npresent, installs dependencies specified in the shrinkwrap.'
              + '\nOtherwise, installs dependencies from ./package.json.'

install.completion = function (opts, cb) {
  // install can complete to a folder with a package.json, or any package.
  // if it has a slash, then it's gotta be a folder
  // if it starts with https?://, then just give up, because it's a url
  // for now, not yet implemented.
  var registry = npm.registry
  mapToRegistry('-/short', npm.config, function (shortEr, shortUri) {
    if (shortEr) return cb(shortEr)

    registry.get(shortUri, null, function (getShortEr, pkgs) {
      if (getShortEr) return cb()
      if (!opts.partialWord) return cb(null, pkgs)

      var name = npa(opts.partialWord).name
      pkgs = pkgs.filter(function (p) {
        return p.indexOf(name) === 0
      })

      if (pkgs.length !== 1 && opts.partialWord === name) {
        return cb(null, pkgs)
      }

      mapToRegistry(pkgs[0], npm.config, function (fullEr, fullUri) {
        if (fullEr) return cb(fullEr)

        registry.get(fullUri, null, function (getFullEr, d) {
          if (getFullEr) return cb()
          return cb(null, Object.keys(d['dist-tags'] || {})
                    .concat(Object.keys(d.versions || {}))
                    .map(function (t) {
                      return pkgs[0] + '@' + t
                    }))
        })
      })
    })
  })
}

// system packages
var fs = require('fs')
var path = require('path')

// dependencies
var log = require('npmlog')
var readPackageTree = require('read-package-tree')
var chain = require('slide').chain
var archy = require('archy')
var mkdirp = require('mkdirp')
var rimraf = require('rimraf')
var clone = require('lodash.clonedeep')
var npa = require('npm-package-arg')
var iferr = require('iferr')

// npm internal utils
var npm = require('./npm.js')
var mapToRegistry = require('./utils/map-to-registry.js')
var locker = require('./utils/locker.js')
var lock = locker.lock
var unlock = locker.unlock

// install specific libraries
var inflateShrinkwrap = require('./install/inflate-shrinkwrap.js')
var loadDeps = require('./install/deps.js').loadDeps
var loadDevDeps = require('./install/deps.js').loadDevDeps
var loadRequestedDeps = require('./install/deps.js').loadRequestedDeps
var loadExtraneous = require('./install/deps.js').loadExtraneous
var diffTrees = require('./install/diff-trees.js')
var decomposeActions = require('./install/decompose-actions.js')
var validateTree = require('./install/validate-tree.js')
var saveRequested = require('./install/save.js').saveRequested
var getSaveType = require('./install/save.js').getSaveType
var actions = require('./install/actions.js').actions
var doSerial = require('./install/actions.js').doSerial
var doParallel = require('./install/actions.js').doParallel

function unlockCB (lockPath, name, cb) {
  return function (installEr) {
    var args = arguments
    try {
      unlock(lockPath, name, reportErrorAndReturn)
    }
    catch (unlockEx) {
      process.nextTick(function() {
        reportErrorAndReturn(unlockEx)
      })
    }
    function reportErrorAndReturn(unlockEr) {
      if (installEr) {
        if (unlockEr && unlockEr.code !== 'ENOTLOCKED') {
          log.warn('unlock'+name, unlockEr)
        }
        return cb.apply(null, args)
      }
      if (unlockEr) return cb(unlockEr)
      return cb.apply(null, args)
    }
  }
}

function install (args, cb) {
  // the /path/to/node_modules/..
  var where = path.resolve(npm.dir, '..')

  // internal api: install(where, what, cb)
  if (arguments.length === 3) {
    where = args
    args = [].concat(cb) // pass in [] to do default dep-install
    cb = arguments[2]
    log.verbose('install', 'where, what', [where, args])
  }

  if (!npm.config.get('global')) {
    args = args.filter(function (a) {
      return path.resolve(a) !== where
    })
  }

  (new Installer(where, args)).run(cb)
}

function Installer (where, args) {
  this.where = where
  this.args = args
  this.currentTree = null
  this.idealTree = null
  this.differences = {}
  this.todo = null
  this.progress = {}
}
Installer.prototype = {}

Installer.prototype.run = function (cb) {
  this.newTracker(log, 'loadCurrentTree', 4)
  this.newTracker(log, 'loadIdealTree', 12)
  this.newTracker(log, 'generateActionsToTake')
  this.newTracker(log, 'executeActions',  8)
  this.newTracker(log, 'runTopLevelLifecycles',  2)

  var steps = []
  steps.push(
    [this, this.loadCurrentTree],
    [this, this.finishTracker, 'loadCurrentTree'],
    [function (cb) { log.warn('run', 'NEXT'); cb() }],

    [this, this.loadIdealTree],
    [this, this.finishTracker, 'loadIdealTree'],

    [this, this.debugTree, 'currentTree', 'currentTree'],
    [this, this.debugTree, 'idealTree', 'idealTree'],

    [this, this.generateActionsToTake],
    [this, this.finishTracker, 'generateActionsToTake'],

    [this, this.debugActions,  'diffTrees', 'differences'],
    [this, this.debugActions, 'decomposeActions', 'todo'],

    [this, this.executeActions],
    [this, this.finishTracker, 'executeActions'],

    [this, this.runTopLevelLifecycles],
    [this, this.finishTracker, 'runTopLevelLifecycles'])

  if (getSaveType(this.args)) steps.push(
    [this, this.saveToDependencies])

  steps.push(
    [this, this.printInstalled])

  chain(steps, cb)
}

Installer.prototype.newTracker = function (tracker, name, size) {
  this.progress[name] = tracker.newGroup(name, size)
}

Installer.prototype.finishTracker = function (tracker, cb) {
  this.progress[tracker].finish()
  cb()
}

Installer.prototype.loadCurrentTree = function (cb) {
  chain([
    [this, this.readLocalPackageData],
    [this, this.normalizeTree]
  ], cb)
}

Installer.prototype.loadIdealTree = function (cb) {
  this.newTracker(this.progress.loadIdealTree, 'cloneCurrentTree')
  this.newTracker(this.progress.loadIdealTree, 'loadShrinkwrap')
  this.newTracker(this.progress.loadIdealTree, 'loadAllDepsIntoIdealTree', 10)
  chain([
    [this, this.cloneCurrentTreeToIdealTree],
    [this, this.finishTracker, 'cloneCurrentTree'],
    [this, this.loadShrinkwrap],
    [this, this.finishTracker, 'loadShrinkwrap'],
    [this, this.loadAllDepsIntoIdealTree]
  ], cb)
}

Installer.prototype.loadAllDepsIntoIdealTree = function (cb) {
  var saveDeps = getSaveType(this.args)

  var dev = npm.config.get('dev') || !npm.config.get('production')

  var cg = this.progress.loadAllDepsIntoIdealTree
  var installNewModules = !!this.args
  var steps = []

  if (installNewModules) steps.push(
    [loadRequestedDeps, this.args, this.idealTree, saveDeps, cg.newGroup('loadRequestedDeps')])
  steps.push(
    [loadDeps, this.idealTree, cg.newGroup('loadDeps')])
  if (dev) steps.push(
    [loadDevDeps, this.idealTree, cg.newGroup('loadDevDeps')])
  steps.push(
    [loadExtraneous, this.idealTree, cg.newGroup('loadExtraneous')])
  chain(steps, cb)
}

Installer.prototype.generateActionsToTake = function (cb) {
  var cg = this.progress.generateActionsToTake
  this.differences = []
  this.todo = []
  chain([
    [validateTree, this.idealTree, cg.newGroup('validateTree')],
    [diffTrees, this.currentTree, this.idealTree, this.differences, cg.newGroup('diffTrees')],
    [decomposeActions, this.differences, this.todo, cg.newGroup('decomposeActions')]
  ], cb)
}

Installer.prototype.executeActions = function (cb) {
  var todo = this.todo
  var cg = this.progress.executeActions

  var node_modules = path.resolve(this.where, 'node_modules')
  var staging = path.resolve(node_modules, '.staging')
  var steps = []
  var trackLifecycle = cg.newGroup('lifecycle')

  cb = unlockCB(node_modules, '.staging', cb)

  steps.push(
    [doParallel, 'fetch', staging, todo, cg.newGroup('fetch', 10)],
    [lock, node_modules, '.staging'],
    [rimraf, staging],
    [mkdirp, staging],
    [doParallel, 'extract', staging, todo, cg.newGroup('extract', 10)],
    [doParallel, 'preinstall', staging, todo, trackLifecycle.newGroup('preinstall')],
    [doParallel, 'remove', staging, todo, cg.newGroup('remove')],
    [doSerial,   'finalize', staging, todo, cg.newGroup('finalize')],
    [doParallel, 'build', staging, todo, trackLifecycle.newGroup('build')],
    [doSerial,   'install', staging, todo, trackLifecycle.newGroup('install')],
    [doSerial,   'postinstall', staging, todo, trackLifecycle.newGroup('postinstall')])
  if (npm.config.get('npat')) steps.push(
    [doParallel, 'test', staging, todo, trackLifecycle.newGroup('npat')])
  steps.push(
    // TODO add check that .staging is empty? DUBIOUS
    [rimraf, staging])

  chain(steps, cb)
}

Installer.prototype.runTopLevelLifecycles = function (cb) {
  var steps = []
  var trackLifecycle = this.progress.runTopLevelLifecycles

  if (!this.args.length) steps.push(
    [actions.preinstall, this.where, this.idealTree, trackLifecycle.newGroup('preinstall:.')],
    [actions.build, this.where, this.idealTree, trackLifecycle.newGroup('build:.')],
    [actions.postinstall, this.where, this.idealTree, trackLifecycle.newGroup('postinstall:.')])
  if (!this.args.length && npm.config.get('npat')) steps.push(
    [actions.test, this.where, this.idealTree, trackLifecycle.newGroup('npat:.')])
  if (!npm.config.get('production')) steps.push(
    [actions.prepublish, this.where, this.idealTree, trackLifecycle.newGroup('prepublish')])

  chain(steps, cb)
}

Installer.prototype.saveToDependencies = function (cb) {
  saveRequested(this.idealTree, cb)
}

Installer.prototype.readLocalPackageData = function (cb) {
  var self = this
  readPackageTree(this.where, iferr(cb,function (currentTree) {
    self.currentTree = currentTree
    if (!self.args.length && !currentTree.package) {
      log.error('install', "Couldn't read dependencies")
      var er = new Error("ENOENT, open '"+path.join(self.where, 'package.json')+"'")
      er.code = 'ENOPACKAGEJSON'
      er.errno = 34
      return cb(er)
    }
    if (!currentTree.package) currentTree.package = {}
    if (currentTree.package._shrinkwrap) return cb()
    fs.readFile(path.join(self.where, 'npm-shrinkwrap.json'), {encoding:'utf8'}, function (er, data) {
      if (er) return cb()
      try {
        currentTree.package._shrinkwrap = JSON.parse(data)
      }
      catch (ex) {
        return cb(ex)
      }
      return cb()
    })
  }))

}

Installer.prototype.cloneCurrentTreeToIdealTree = function (cb) {
  this.idealTree = clone(this.currentTree)
  cb()
}

Installer.prototype.loadShrinkwrap = function (cb) {
  if (!this.idealTree.package._shrinkwrap) return cb()
  inflateShrinkwrap(this.idealTree, this.idealTree.package._shrinkwrap.dependencies, cb)
}

Installer.prototype.normalizeTree = function (cb) {
  doNormalizeTree(this.currentTree)
  function doNormalizeTree(tree) {
    if (!tree.package.dependencies) tree.package.dependencies = {}
    tree.children.forEach(function (dep) {
      doNormalizeTree(dep)
    })
  }
  cb()
}

Installer.prototype.printInstalled = function (cb) {
  log.clearProgress()
  /*
  TODO: What we actually want to do here is build a tree of installed modules.
  Tricky due to the fact that we can have empty layers. Need to scan up to find the next installed module.
  Since actions include actual link to the point in the tree that we need, we can flag modules
  as installed.
  */
  var self = this
  this.differences.forEach(function (action) {
    var mutation = action[0]
    if (mutation === 'add' || mutation === 'update') mutation = '+'
    else if (mutation === 'remove') mutation = '-'
    var child = action[1]
    var name = child.package.name+'@'+child.package.version
    console.log(mutation + ' ' + name + ' ' + path.relative(self.where, child.path))
  })
  log.showProgress()
  cb()
}

Installer.prototype.debugActions = function (name, actionListName, cb) {
  var actionsToLog = this[actionListName]
  log.silly(name, 'action count', actionsToLog.length)
  actionsToLog.forEach(function (action) {
    log.silly(name, action.map(function (value) {
      return (value && value.package) ? value.package.name + '@' + value.package.version : value
    }).join(' '))
  })
  cb()
}

// This takes an object and a property name instead of a value to allow us
// to define the arguments for use by chain before the property exists yet.
Installer.prototype.debugTree = function (name, treeName, cb) {
  log.silly(name, this.prettify(this[treeName]).trim())
  cb()
}

Installer.prototype.prettify = function (tree) {
  function byName (aa,bb) {
    return aa.package.name.localeCompare(bb)
  }
  return archy( {
    label: tree.package.name + '@' + tree.package.version
           + ' ' + tree.path,
    nodes: (tree.children || []).sort(byName).map(function expandChild (child) {
      return {
        label: child.package.name + '@' + child.package.version,
        nodes: child.children.sort(byName).map(expandChild)
      }
    })
  }, '', { unicode: npm.config.get('unicode') })
}
