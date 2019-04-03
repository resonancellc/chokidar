'use strict';
const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const sysPath = require('path');
const readdirp = require('readdirp');
const asyncEach = require('async-each');
const anymatch = require('anymatch');
const globParent = require('glob-parent');
const isGlob = require('is-glob');
const braces = require('braces');
const normalizePath = require('normalize-path');

const NodeFsHandler = require('./lib/nodefs-handler');
const FsEventsHandler = require('./lib/fsevents-handler');

/**
 * @typedef {String} Path
 * @typedef {'all'|'add'|'addDir'|'change'|'unlink'|'unlinkDir'|'raw'|'error'|'ready'} EventName
 * @typedef {'readdir'|'watch'|'add'|'remove'|'change'} ThrottleType
 */

/**
 *
 * @typedef {Object} WatchHelpers
 * @property {Boolean} followSymlinks
 * @property {'stat'|'lstat'} statMethod
 * @property {Path} path
 * @property {Path} watchPath
 * @property {Function} entryPath
 * @property {Boolean} hasGlob
 * @property {Object} globFilter
 * @property {Function} filterPath
 * @property {Function} filterDir
 */

/**
 * @param {String|Array<String>} value
 */
const arrify = (value = []) => Array.isArray(value) ? value : [value];

const flatten = (list, result = []) => {
  list.forEach(item => {
    if (Array.isArray(item)) {
      flatten(item, result);
    } else {
      result.push(item);
    }
  });
  return result;
};

const back = /\\/g;
const double = /\/\//;
const slash = '/';

const toUnix = (string) => {
  let str = string.replace(back, slash);
  while (str.match(double)) {
    str = str.replace(double, slash);
  }
  return str;
};

// Our version of upath.normalize
// TODO: this is not equal to path-normalize module - investigate why
const normalizePathToUnix = (path) => toUnix(sysPath.normalize(toUnix(path)));

const normalizeIgnored = (cwd) => (path) => {
  if (typeof path !== 'string') return path;
  return normalizePathToUnix(sysPath.isAbsolute(path) ? path : sysPath.join(cwd, path));
};

const dotRe = /\..*\.(sw[px])$|\~$|\.subl.*\.tmp/;
const replacerRe = /^\.[\/\\]/;
const emptyFn = () => {};

class DirEntry {
  /**
   * @param {Path} dir
   * @param {Function} removeWatcher
   */
  constructor(dir, removeWatcher) {
    this.path = dir;
    this._removeWatcher = removeWatcher;
    /** @type {Set<String>} */
    this.items = new Set();
  }
  add(item) {
    if (item !== '.' && item !== '..') this.items.add(item);
  }
  remove(item) {
    this.items.delete(item);

    if (!this.items.size) {
      const dir = this.path;
      fs.readdir(dir, err => {
        if (err) this._removeWatcher(sysPath.dirname(dir), sysPath.basename(dir));
      });
    }
  }
  has(item) {
    return this.items.has(item);
  }

  /**
   * @returns {Array<String>}
   */
  getChildren() {
    return Array.from(this.items.values());
  }
}

// Public: Main class.
// Watches files & directories for changes.
//
// * _opts - object, chokidar options hash
//
// Emitted events:
// `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `all`, `error`
//
// Examples
//
//  const watcher = new FSWatcher()
//    .add(directories)
//    .on('add', path => log('File', path, 'was added'))
//    .on('change', path => log('File', path, 'was changed'))
//    .on('unlink', path => log('File', path, 'was removed'))
//    .on('all', (event, path) => log(path, ' emitted ', event))
//
class FSWatcher extends EventEmitter {
// Not indenting methods for history sake; for now.
constructor(_opts) {
  super();

  const opts = {};
  if (_opts) Object.assign(opts, _opts); // for frozen objects

  /** @type {Map<String, DirEntry>} */
  this._watched = new Map();
  /** @type {Map<String, Array>} */
  this._closers = new Map();
  /** @type {Set<String>} */
  this._ignoredPaths = new Set();

  /** @type {Map<ThrottleType, Map>} */
  this._throttled = new Map();

  /** @type {Map<Path, String|Boolean>} */
  this._symlinkPaths = new Map();

  this._streams = new Set();
  this.closed = false;

  const undef = (key) => opts[key] === undefined;

  // Set up default options.
  if (undef('persistent')) opts.persistent = true;
  if (undef('ignoreInitial')) opts.ignoreInitial = false;
  if (undef('ignorePermissionErrors')) opts.ignorePermissionErrors = false;
  if (undef('interval')) opts.interval = 100;
  if (undef('binaryInterval')) opts.binaryInterval = 300;
  if (undef('disableGlobbing')) opts.disableGlobbing = false;
  opts.enableBinaryInterval = opts.binaryInterval !== opts.interval;

  // Enable fsevents on OS X when polling isn't explicitly enabled.
  if (undef('useFsEvents')) opts.useFsEvents = !opts.usePolling;

  // If we can't use fsevents, ensure the options reflect it's disabled.
  if (!this.canUseFsevents()) opts.useFsEvents = false;

  // Use polling on Mac if not using fsevents.
  // Other platforms use non-polling fs_watch.
  if (undef('usePolling') && !opts.useFsEvents) {
    opts.usePolling = process.platform === 'darwin';
  }

  // Global override (useful for end-developers that need to force polling for all
  // instances of chokidar, regardless of usage/dependency depth)
  const envPoll = process.env.CHOKIDAR_USEPOLLING;
  if (envPoll !== undefined) {
    const envLower = envPoll.toLowerCase();

    if (envLower === 'false' || envLower === '0') {
      opts.usePolling = false;
    } else if (envLower === 'true' || envLower === '1') {
      opts.usePolling = true;
    } else {
      opts.usePolling = !!envLower;
    }
  }
  const envInterval = process.env.CHOKIDAR_INTERVAL;
  if (envInterval) {
    opts.interval = parseInt(envInterval);
  }

  // Editor atomic write normalization enabled by default with fs.watch
  if (undef('atomic')) opts.atomic = !opts.usePolling && !opts.useFsEvents;
  if (opts.atomic) this._pendingUnlinks = new Map();

  if (undef('followSymlinks')) opts.followSymlinks = true;

  if (undef('awaitWriteFinish')) opts.awaitWriteFinish = false;
  if (opts.awaitWriteFinish === true) opts.awaitWriteFinish = {};
  const awf = opts.awaitWriteFinish;
  if (awf) {
    if (!awf.stabilityThreshold) awf.stabilityThreshold = 2000;
    if (!awf.pollInterval) awf.pollInterval = 100;
    this._pendingWrites = new Map();
  }
  if (opts.ignored) opts.ignored = arrify(opts.ignored);

  let readyCalls = 0;
  this._emitReady = () => {
    readyCalls++;
    if (readyCalls >= this._readyCount) {
      this._emitReady = emptyFn;
      this._readyEmitted = true;
      // use process.nextTick to allow time for listener to be bound
      process.nextTick(this.emit.bind(this, 'ready'));
    }
  };
  this._emitRaw = (...args) => this.emit('raw', ...args);

  this._readyEmitted = false;

  this.options = opts;

  // You’re frozen when your heart’s not open.
  Object.freeze(opts);

  // Attach watch handler prototype methods
  if (opts.useFsEvents && this.canUseFsevents()) {
    this._fsEventsHandler = new FsEventsHandler(this);
  } else {
    this._nodeFsHandler = new NodeFsHandler(this);
  }
}

_getGlobIgnored() {
  return Array.from(this._ignoredPaths.values());
}

// Common helpers
// --------------

/**
 * Normalize and emit events.
 * Calling _emit DOES NOT MEAN emit() would be called!
 * @param {EventName} event Type of event
 * @param {Path} path File or directory path
 * @param {*=} val1 arguments to be passed with event
 * @param {*=} val2
 * @param {*=} val3
 * @returns the error if defined, otherwise the value of the FSWatcher instance's `closed` flag
 */
_emit(event, path, val1, val2, val3) {
  const opts = this.options;
  if (opts.cwd) path = sysPath.relative(opts.cwd, path);
  /** @type Array<any> */
  const args = [event, path];
  if (val3 !== undefined) args.push(val1, val2, val3);
  else if (val2 !== undefined) args.push(val1, val2);
  else if (val1 !== undefined) args.push(val1);

  const awf = opts.awaitWriteFinish;
  let pw;
  if (awf && (pw = this._pendingWrites.get(path))) {
    pw.lastChange = new Date();
    return this;
  }

  if (opts.atomic) {
    if (event === 'unlink') {
      this._pendingUnlinks.set(path, args);
      setTimeout(() => {
        this._pendingUnlinks.forEach((entry, path) => {
          this.emit.apply(this, entry);
          this.emit.apply(this, ['all'].concat(entry));
          this._pendingUnlinks.delete(path);
        });
      }, typeof opts.atomic === "number" ? opts.atomic : 100);
      return this;
    } else if (event === 'add' && this._pendingUnlinks.has(path)) {
      event = args[0] = 'change';
      this._pendingUnlinks.delete(path);
    }
  }

  const emitEvent = () => {
    this.emit.apply(this, args);
    if (event !== 'error') this.emit.apply(this, ['all'].concat(args));
  };

  if (awf && (event === 'add' || event === 'change') && this._readyEmitted) {
    const awfEmit = (err, stats) => {
      if (err) {
        event = args[0] = 'error';
        args[1] = err;
        emitEvent();
      } else if (stats) {
        // if stats doesn't exist the file must have been deleted
        if (args.length > 2) {
          args[2] = stats;
        } else {
          args.push(stats);
        }
        emitEvent();
      }
    };

    this._awaitWriteFinish(path, awf.stabilityThreshold, event, awfEmit);
    return this;
  }

  if (event === 'change') {
    const isThrottled = !this._throttle('change', path, 50);
    if (isThrottled) return this;
  }

  if (opts.alwaysStat && val1 === undefined &&
    (event === 'add' || event === 'addDir' || event === 'change')
  ) {
    const fullPath = opts.cwd ? sysPath.join(opts.cwd, path) : path;
    fs.stat(fullPath, (error, stats) => {
      // Suppress event when fs_stat fails, to avoid sending undefined 'stat'
      if (error || !stats) return;

      args.push(stats);
      emitEvent();
    });
  } else {
    emitEvent();
  }

  return this;
}

/**
 * Common handler for errors
 * @param {Error} error
 * @returns {Error|Boolean} The error if defined, otherwise the value of the FSWatcher instance's `closed` flag
 */
_handleError(error) {
  const code = error && error.code;
  const ipe = this.options.ignorePermissionErrors;
  if (error &&
    code !== 'ENOENT' &&
    code !== 'ENOTDIR' &&
    (!ipe || (code !== 'EPERM' && code !== 'EACCES'))
  ) this.emit('error', error);
  return error || this.closed;
}

/**
 * Helper utility for throttling
 * @param {ThrottleType} actionType type being throttled
 * @param {Path} path being acted upon
 * @param {Number} timeout duration of time to suppress duplicate actions
 * @returns {Object|false} tracking object or false if action should be suppressed
 */
_throttle(actionType, path, timeout) {
  if (!this._throttled.has(actionType)) {
    this._throttled.set(actionType, new Map());
  }

  /** @type {Map<Path, Object>} */
  const action = this._throttled.get(actionType);
  /** @type {Object} */
  const actionPath = action.get(path);

  if (actionPath) {
    actionPath.count++;
    return false;
  }

  let timeoutObject;
  const clear = () => {
    const item = action.get(path);
    const count = item ? item.count : 0;
    action.delete(path);
    clearTimeout(timeoutObject);
    if (item) clearTimeout(item.timeoutObject);
    return count;
  };
  timeoutObject = setTimeout(clear, timeout);
  const thr = {timeoutObject: timeoutObject, clear: clear, count: 0};
  action.set(path, thr);
  return thr;
}

_incrReadyCount() {
  return this._readyCount++;
}

/**
 * Awaits write operation to finish.
 * Polls a newly created file for size variations. When files size does not change for 'threshold' milliseconds calls callback.
 * @param {Path} path being acted upon
 * @param {Number} threshold Time in milliseconds a file size must be fixed before acknowledging write OP is finished
 * @param {EventName} event
 * @param {Function} awfEmit Callback to be called when ready for event to be emitted.
 */
_awaitWriteFinish(path, threshold, event, awfEmit) {
  let timeoutHandler;

  let fullPath = path;
  if (this.options.cwd && !sysPath.isAbsolute(path)) {
    fullPath = sysPath.join(this.options.cwd, path);
  }

  const now = new Date();

  const awaitWriteFinish = (prevStat) => {
    fs.stat(fullPath, (err, curStat) => {
      if (err || !this._pendingWrites.has(path)) {
        if (err && err.code !== 'ENOENT') awfEmit(err);
        return;
      }

      const now = Number(new Date());

      if (prevStat && curStat.size != prevStat.size) {
        this._pendingWrites.get(path).lastChange = now;
      }
      const pw = this._pendingWrites.get(path);
      const df = now - pw.lastChange;

      if (df >= threshold) {
        this._pendingWrites.delete(path);
        awfEmit(null, curStat);
      } else {
        timeoutHandler = setTimeout(
          awaitWriteFinish.bind(this, curStat),
          this.options.awaitWriteFinish.pollInterval
        );
      }
    });
  };

  if (!this._pendingWrites.has(path)) {
    this._pendingWrites.set(path, {
      lastChange: now,
      cancelWait: () => {
        this._pendingWrites.delete(path);
        clearTimeout(timeoutHandler);
        return event;
      }
    });
    timeoutHandler = setTimeout(
      awaitWriteFinish.bind(this),
      this.options.awaitWriteFinish.pollInterval
    );
  }
}

/**
 * Determines whether user has asked to ignore this path.
 * @param {Path} path filepath or dir
 * @param {fs.Stats=} stats result of fs.stat
 * @returns {Boolean}
 */
_isIgnored(path, stats) {
  if (this.options.atomic && dotRe.test(path)) return true;
  if (!this._userIgnored) {
    const cwd = this.options.cwd;
    const ign = this.options.ignored;

    let ignored = ign;
    if (cwd && ign) ignored = ign.map(normalizeIgnored(cwd));
    const paths = arrify(ignored)
      .filter((path) => typeof path === 'string' && !isGlob(path))
      .map((path) => path + '/**');
    this._userIgnored = anymatch(
      this._getGlobIgnored().concat(ignored).concat(paths)
    );
  }

  return this._userIgnored([path, stats]);
}

_isntIgnored(path, stat) {
  return !this._isIgnored(path, stat);
}

/**
 * Provides a set of common helpers and properties relating to symlink and glob handling.
 * @param {Path} path file, directory, or glob pattern being watched
 * @param {Number=} depth at any depth > 0, this isn't a glob
 * @returns {WatchHelpers} object containing helpers for this path
 */
_getWatchHelpers(path, depth) {
  path = path.replace(replacerRe, '');
  const watchPath = depth || this.options.disableGlobbing || !isGlob(path) ? path : globParent(path);
  const fullWatchPath = sysPath.resolve(watchPath);
  const hasGlob = watchPath !== path;
  const globFilter = hasGlob ? anymatch(path) : false;
  const follow = this.options.followSymlinks;
  /** @type {any} */
  let globSymlink = hasGlob && follow ? null : false;

  const checkGlobSymlink = (entry) => {
    // only need to resolve once
    // first entry should always have entry.parentDir === ''
    if (globSymlink == null) {
      globSymlink = entry.fullParentDir === fullWatchPath ? false : {
        realPath: entry.fullParentDir,
        linkPath: fullWatchPath
      };
    }

    if (globSymlink) {
      return entry.fullPath.replace(globSymlink.realPath, globSymlink.linkPath);
    }

    return entry.fullPath;
  };

  const entryPath = (entry) => {
    return sysPath.join(watchPath,
      sysPath.relative(watchPath, checkGlobSymlink(entry))
    );
  };

  const filterPath = (entry) => {
    if (entry.stat && entry.stat.isSymbolicLink()) return filterDir(entry);
    const resolvedPath = entryPath(entry);
    const matchesGlob = !hasGlob || globFilter(resolvedPath);
    return matchesGlob &&
      this._isntIgnored(resolvedPath, entry.stat) &&
      this._hasReadPermissions(entry.stat);
  };

  const getDirParts = (path) => {
    if (!hasGlob) return [];
    const parts = [];
    const expandedPath = braces.expand(path);
    expandedPath.forEach((path) => {
      parts.push(sysPath.relative(watchPath, path).split(/[\/\\]/));
    });
    return parts;
  };

  const dirParts = getDirParts(path);
  dirParts.forEach((parts) => {
    if (parts.length > 1) parts.pop();
  });
  let unmatchedGlob;

  const filterDir = (entry) => {
    if (hasGlob) {
      const entryParts = getDirParts(checkGlobSymlink(entry));
      let globstar = false;
      unmatchedGlob = !dirParts.some((parts) => {
        return parts.every((part, i) => {
          if (part === '**') globstar = true;
          return globstar || !entryParts[0][i] || anymatch(part, entryParts[0][i]);
        });
      });
    }
    return !unmatchedGlob && this._isntIgnored(entryPath(entry), entry.stat);
  };

  return {
    followSymlinks: follow,
    statMethod: follow ? 'stat' : 'lstat',
    path: path,
    watchPath: watchPath,
    entryPath: entryPath,
    hasGlob: hasGlob,
    globFilter: globFilter,
    filterPath: filterPath,
    filterDir: filterDir
  };
}

// Directory helpers
// -----------------

/**
 * Provides directory tracking objects
 * @param {String} directory path of the directory
 * @returns {DirEntry} the directory's tracking object
 */
_getWatchedDir(directory) {
  if (!this._boundRemove) this._boundRemove = this._remove.bind(this);
  const dir = sysPath.resolve(directory);
  if (!this._watched.has(dir)) this._watched.set(dir, new DirEntry(dir, this._boundRemove));
  return this._watched.get(dir);
}

// File helpers
// ------------

/**
 * Check for read permissions.
 * Based on this answer on SO: http://stackoverflow.com/a/11781404/1358405
 * @param {fs.Stats} stats - object, result of fs_stat
 * @returns {Boolean} indicates whether the file can be read
*/
_hasReadPermissions(stats) {
  if (this.options.ignorePermissionErrors) return true;

  const st = (stats && stats.mode) & 0o777;
  const it = parseInt(st.toString(8)[0], 10);
  return Boolean(4 & it);
}

/**
 * Handles emitting unlink events for
 * files and directories, and via recursion, for
 * files and directories within directories that are unlinked
 * @param {String} directory within which the following item is located
 * @param {String} item      base path of item/directory
 * @returns {void}
*/
_remove(directory, item) {
  // if what is being deleted is a directory, get that directory's paths
  // for recursive deleting and cleaning of watched object
  // if it is not a directory, nestedDirectoryChildren will be empty array
  const path = sysPath.join(directory, item);
  const fullPath = sysPath.resolve(path);
  const isDirectory = this._watched.has(path) || this._watched.has(fullPath);

  // prevent duplicate handling in case of arriving here nearly simultaneously
  // via multiple paths (such as _handleFile and _handleDir)
  if (!this._throttle('remove', path, 100)) return;

  // if the only watched file is removed, watch for its return
  if (!isDirectory && !this.options.useFsEvents && this._watched.size === 1) {
    this.add(directory, item, true);
  }

  // This will create a new entry in the watched object in either case
  // so we got to do the directory check beforehand
  const wp = this._getWatchedDir(path);
  const nestedDirectoryChildren = wp.getChildren();

  // Recursively remove children directories / files.
  nestedDirectoryChildren.forEach(nested => this._remove(path, nested));

  // Check if item was on the watched list and remove it
  const parent = this._getWatchedDir(directory);
  const wasTracked = parent.has(item);
  parent.remove(item);

  // If we wait for this file to be fully written, cancel the wait.
  let relPath = path;
  if (this.options.cwd) relPath = sysPath.relative(this.options.cwd, path);
  if (this.options.awaitWriteFinish && this._pendingWrites.has(relPath)) {
    const event = this._pendingWrites.get(relPath).cancelWait();
    if (event === 'add') return;
  }

  // The Entry will either be a directory that just got removed
  // or a bogus entry to a file, in either case we have to remove it
  this._watched.delete(path);
  this._watched.delete(fullPath);
  const eventName = isDirectory ? 'unlinkDir' : 'unlink';
  if (wasTracked && !this._isIgnored(path)) this._emit(eventName, path);

  // Avoid conflicts if we later create another file with the same name
  if (!this.options.useFsEvents) {
    this._closePath(path);
  }
}

/**
 *
 * @param {Path} path
 */
_closePath(path) {
  let closers = this._closers.get(path);
  if (!closers) return;
  closers.forEach(closer => closer());
  this._closers.delete(path);
  closers = [];
  const dir = sysPath.dirname(path);
  this._getWatchedDir(dir).remove(sysPath.basename(path));
}

/**
 *
 * @param {Path} path
 * @param {Function} closer
 */
_addPathCloser(path, closer) {
  if (!closer) return;
  let list = this._closers.get(path);
  if (!list) {
    list = [];
    this._closers.set(path, list);
  }
  list.push(closer);
}

_readdirp(options) {
  let stream = readdirp(options);
  this._streams.add(stream);
  stream.on('close', () => {
    stream = null;
  })
  stream.on('end', () => {
    if (stream) {
      this._streams.delete(stream);
      stream = null;
    }
  })
  return stream;
}

/**
 * Adds paths to be watched on an existing FSWatcher instance
 * @param {Path|Array<Path>} paths_
 * @param {String=} _origAdd private; for handling non-existent paths to be watched
 * @param {Boolean=} _internal private; indicates a non-user add
 * @returns {FSWatcher} for chaining
 */
add(paths_, _origAdd, _internal) {
  const disableGlobbing = this.options.disableGlobbing;
  const cwd = this.options.cwd;
  this.closed = false;

  /**
   * @type {Array<String>}
   */
  let paths = flatten(arrify(paths_));

  if (!paths.every(p => typeof p === 'string')) {
    throw new TypeError('Non-string provided as watch path: ' + paths);
  }

  if (cwd) paths = paths.map((path) => {
    let absPath;
    if (sysPath.isAbsolute(path)) {
      absPath = path;
    } else if (path[0] === '!') {
      absPath = '!' + sysPath.join(cwd, path.substring(1));
    } else {
      absPath = sysPath.join(cwd, path);
    }

    // Check `path` instead of `absPath` because the cwd portion can't be a glob
    if (disableGlobbing || !isGlob(path)) {
      return absPath;
    } else {
      return normalizePath(absPath);
    }
  });

  // set aside negated glob strings
  paths = paths.filter((path) => {
    if (path[0] === '!') {
      this._ignoredPaths.add(path.substring(1));
      return false;
    } else {
      // if a path is being added that was previously ignored, stop ignoring it
      this._ignoredPaths.delete(path);
      this._ignoredPaths.delete(path + '/**');

      // reset the cached userIgnored anymatch fn
      // to make ignoredPaths changes effective
      this._userIgnored = null;

      return true;
    }
  });

  if (this.options.useFsEvents && this.canUseFsevents()) {
    if (!this._readyCount) this._readyCount = paths.length;
    if (this.options.persistent) this._readyCount *= 2;
    paths.forEach((path) => this._fsEventsHandler._addToFsEvents(path));
  } else {
    if (!this._readyCount) this._readyCount = 0;
    this._readyCount += paths.length;
    asyncEach(paths, (path, next) => {
      this._nodeFsHandler._addToNodeFs(path, !_internal, 0, 0, _origAdd, (err, res) => {
        if (res) this._emitReady();
        next(err, res);
      });
    }, (error, results) => {
      results.forEach((item) => {
        if (!item || this.closed) return;
        this.add(sysPath.dirname(item), sysPath.basename(_origAdd || item));
      });
    });
  }

  return this;
}

/**
 * Close watchers or start ignoring events from specified paths.
 * @param {Path|Array<Path>} paths - string or array of strings, file/directory paths and/or globs
 * @returns {FSWatcher} for chaining
*/
unwatch(paths) {
  if (this.closed) return this;
  paths = flatten(arrify(paths));

  paths.forEach((path) => {
    // convert to absolute path unless relative path already matches
    if (!sysPath.isAbsolute(path) && !this._closers.has(path)) {
      if (this.options.cwd) path = sysPath.join(this.options.cwd, path);
      path = sysPath.resolve(path);
    }

    this._closePath(path);

    this._ignoredPaths.add(path);
    if (this._watched.has(path)) {
      this._ignoredPaths.add(path + '/**');
    }

    // reset the cached userIgnored anymatch fn
    // to make ignoredPaths changes effective
    this._userIgnored = null;
  });

  return this;
}

/**
 * Close watchers and remove all listeners from watched paths.
 * @returns {FSWatcher} for chaining
*/
close() {
  if (this.closed) return this;
  this.closed = true;

  this._closers.forEach(closerList => closerList.forEach(closer => closer()));
  this._closers.clear();
  this._watched.clear();
  this._streams.forEach(stream => stream.destroy());
  this._streams.clear();
  this.removeAllListeners();

  return this;
}

/**
 * Expose list of watched paths
 * @returns {Object} for chaining
*/
getWatched() {
  const watchList = {};
  this._watched.forEach((entry, dir) => {
    const key = this.options.cwd ? sysPath.relative(this.options.cwd, dir) : dir;
    watchList[key || '.'] = entry.getChildren().sort();
  });
  return watchList;
}

canUseFsevents() {
  return FsEventsHandler.canUse();
}

}

// Export FSWatcher class
exports.FSWatcher = FSWatcher;

/**
 * Instantiates watcher with paths to be tracked.
 * @param {String|Array<String>} paths file/directory paths and/or globs
 * @param {Object=} options chokidar opts
 * @returns an instance of FSWatcher for chaining.
 */
const watch = (paths, options) => new FSWatcher(options).add(paths);
exports.watch = watch;
