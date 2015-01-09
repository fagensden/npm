'use strict'
// remove a package.

module.exports = uninstall
module.exports.Uninstaller = Uninstaller

uninstall.usage = 'npm uninstall <name>[@<version> [<name>[@<version>] ...]'
                + '\nnpm rm <name>[@<version> [<name>[@<version>] ...]'

var util = require('util')
var path = require('path')
var chain = require('slide').chain
var npm = require('./npm.js')
var Installer = require('./install.js').Installer
var getSaveType = require('./install/save.js').getSaveType
var removeDeps = require('./install/deps.js').removeDeps
var loadExtraneous = require('./install/deps.js').loadExtraneous

uninstall.completion = require('./utils/completion/installed-shallow.js')

function uninstall (args, cb) {
  // the /path/to/node_modules/..
  var where = path.resolve(npm.dir, '..')

  if (!npm.config.get('global')) {
    args = args.filter(function (a) {
      return path.resolve(a) !== where
    })
  }

  (new Uninstaller(where, args)).run(cb)
}


function Uninstaller (where, args) {
  Installer.call(this, where, args)
}
util.inherits(Uninstaller, Installer)


Uninstaller.prototype.loadAllDepsIntoIdealTree = function (cb) {
  var saveDeps = getSaveType(this.args)

  var cg = this.progress.loadAllDepsIntoIdealTree
  var steps = []

  steps.push(
    [removeDeps, this.args, this.idealTree, saveDeps, cg.newGroup('removeDeps')],
    [loadExtraneous, this.idealTree, cg.newGroup('loadExtraneous')])
  chain(steps, cb)
}
