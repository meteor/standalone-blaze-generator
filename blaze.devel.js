Meteor = {};


(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;



/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.autopublish = {};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;

/* Package-scope variables */
var Deps;

(function () {

                                                                                //

Deps = {};

// http://docs.meteor.com/#deps_active
Deps.active = false;

// http://docs.meteor.com/#deps_currentcomputation
Deps.currentComputation = null;

var setCurrentComputation = function (c) {
  Deps.currentComputation = c;
  Deps.active = !! c;
};

// _assign is like _.extend or the upcoming Object.assign.
// Copy src's own, enumerable properties onto tgt and return
// tgt.
var _hasOwnProperty = Object.prototype.hasOwnProperty;
var _assign = function (tgt, src) {
  for (var k in src) {
    if (_hasOwnProperty.call(src, k))
      tgt[k] = src[k];
  }
  return tgt;
};

var _debugFunc = function () {
  // lazy evaluation because `Meteor` does not exist right away
  return (typeof Meteor !== "undefined" ? Meteor._debug :
          ((typeof console !== "undefined") && console.log ?
           function () { console.log.apply(console, arguments); } :
           function () {}));
};

var _throwOrLog = function (from, e) {
  if (throwFirstError) {
    throw e;
  } else {
    _debugFunc()("Exception from Deps " + from + " function:",
                 e.stack || e.message);
  }
};

// Like `Meteor._noYieldsAllowed(function () { f(comp); })` but shorter,
// and doesn't clutter the stack with an extra frame on the client,
// where `_noYieldsAllowed` is a no-op.  `f` may be a computation
// function or an onInvalidate callback.
var callWithNoYieldsAllowed = function (f, comp) {
  if ((typeof Meteor === 'undefined') || Meteor.isClient) {
    f(comp);
  } else {
    Meteor._noYieldsAllowed(function () {
      f(comp);
    });
  }
};

var nextId = 1;
// computations whose callbacks we should call at flush time
var pendingComputations = [];
// `true` if a Deps.flush is scheduled, or if we are in Deps.flush now
var willFlush = false;
// `true` if we are in Deps.flush now
var inFlush = false;
// `true` if we are computing a computation now, either first time
// or recompute.  This matches Deps.active unless we are inside
// Deps.nonreactive, which nullfies currentComputation even though
// an enclosing computation may still be running.
var inCompute = false;
// `true` if the `_throwFirstError` option was passed in to the call
// to Deps.flush that we are in. When set, throw rather than log the
// first error encountered while flushing. Before throwing the error,
// finish flushing (from a finally block), logging any subsequent
// errors.
var throwFirstError = false;

var afterFlushCallbacks = [];

var requireFlush = function () {
  if (! willFlush) {
    setTimeout(Deps.flush, 0);
    willFlush = true;
  }
};

// Deps.Computation constructor is visible but private
// (throws an error if you try to call it)
var constructingComputation = false;

//
// http://docs.meteor.com/#deps_computation
//
Deps.Computation = function (f, parent) {
  if (! constructingComputation)
    throw new Error(
      "Deps.Computation constructor is private; use Deps.autorun");
  constructingComputation = false;

  var self = this;

  // http://docs.meteor.com/#computation_stopped
  self.stopped = false;

  // http://docs.meteor.com/#computation_invalidated
  self.invalidated = false;

  // http://docs.meteor.com/#computation_firstrun
  self.firstRun = true;

  self._id = nextId++;
  self._onInvalidateCallbacks = [];
  // the plan is at some point to use the parent relation
  // to constrain the order that computations are processed
  self._parent = parent;
  self._func = f;
  self._recomputing = false;

  var errored = true;
  try {
    self._compute();
    errored = false;
  } finally {
    self.firstRun = false;
    if (errored)
      self.stop();
  }
};

_assign(Deps.Computation.prototype, {

  // http://docs.meteor.com/#computation_oninvalidate
  onInvalidate: function (f) {
    var self = this;

    if (typeof f !== 'function')
      throw new Error("onInvalidate requires a function");

    if (self.invalidated) {
      Deps.nonreactive(function () {
        callWithNoYieldsAllowed(f, self);
      });
    } else {
      self._onInvalidateCallbacks.push(f);
    }
  },

  // http://docs.meteor.com/#computation_invalidate
  invalidate: function () {
    var self = this;
    if (! self.invalidated) {
      // if we're currently in _recompute(), don't enqueue
      // ourselves, since we'll rerun immediately anyway.
      if (! self._recomputing && ! self.stopped) {
        requireFlush();
        pendingComputations.push(this);
      }

      self.invalidated = true;

      // callbacks can't add callbacks, because
      // self.invalidated === true.
      for(var i = 0, f; f = self._onInvalidateCallbacks[i]; i++) {
        Deps.nonreactive(function () {
          callWithNoYieldsAllowed(f, self);
        });
      }
      self._onInvalidateCallbacks = [];
    }
  },

  // http://docs.meteor.com/#computation_stop
  stop: function () {
    if (! this.stopped) {
      this.stopped = true;
      this.invalidate();
    }
  },

  _compute: function () {
    var self = this;
    self.invalidated = false;

    var previous = Deps.currentComputation;
    setCurrentComputation(self);
    var previousInCompute = inCompute;
    inCompute = true;
    try {
      callWithNoYieldsAllowed(self._func, self);
    } finally {
      setCurrentComputation(previous);
      inCompute = false;
    }
  },

  _recompute: function () {
    var self = this;

    self._recomputing = true;
    try {
      while (self.invalidated && ! self.stopped) {
        try {
          self._compute();
        } catch (e) {
          _throwOrLog("recompute", e);
        }
        // If _compute() invalidated us, we run again immediately.
        // A computation that invalidates itself indefinitely is an
        // infinite loop, of course.
        //
        // We could put an iteration counter here and catch run-away
        // loops.
      }
    } finally {
      self._recomputing = false;
    }
  }
});

//
// http://docs.meteor.com/#deps_dependency
//
Deps.Dependency = function () {
  this._dependentsById = {};
};

_assign(Deps.Dependency.prototype, {
  // http://docs.meteor.com/#dependency_depend
  //
  // Adds `computation` to this set if it is not already
  // present.  Returns true if `computation` is a new member of the set.
  // If no argument, defaults to currentComputation, or does nothing
  // if there is no currentComputation.
  depend: function (computation) {
    if (! computation) {
      if (! Deps.active)
        return false;

      computation = Deps.currentComputation;
    }
    var self = this;
    var id = computation._id;
    if (! (id in self._dependentsById)) {
      self._dependentsById[id] = computation;
      computation.onInvalidate(function () {
        delete self._dependentsById[id];
      });
      return true;
    }
    return false;
  },

  // http://docs.meteor.com/#dependency_changed
  changed: function () {
    var self = this;
    for (var id in self._dependentsById)
      self._dependentsById[id].invalidate();
  },

  // http://docs.meteor.com/#dependency_hasdependents
  hasDependents: function () {
    var self = this;
    for(var id in self._dependentsById)
      return true;
    return false;
  }
});

_assign(Deps, {
  // http://docs.meteor.com/#deps_flush
  flush: function (_opts) {
    // XXX What part of the comment below is still true? (We no longer
    // have Spark)
    //
    // Nested flush could plausibly happen if, say, a flush causes
    // DOM mutation, which causes a "blur" event, which runs an
    // app event handler that calls Deps.flush.  At the moment
    // Spark blocks event handlers during DOM mutation anyway,
    // because the LiveRange tree isn't valid.  And we don't have
    // any useful notion of a nested flush.
    //
    // https://app.asana.com/0/159908330244/385138233856
    if (inFlush)
      throw new Error("Can't call Deps.flush while flushing");

    if (inCompute)
      throw new Error("Can't flush inside Deps.autorun");

    inFlush = true;
    willFlush = true;
    throwFirstError = !! (_opts && _opts._throwFirstError);

    var finishedTry = false;
    try {
      while (pendingComputations.length ||
             afterFlushCallbacks.length) {

        // recompute all pending computations
        while (pendingComputations.length) {
          var comp = pendingComputations.shift();
          comp._recompute();
        }

        if (afterFlushCallbacks.length) {
          // call one afterFlush callback, which may
          // invalidate more computations
          var func = afterFlushCallbacks.shift();
          try {
            func();
          } catch (e) {
            _throwOrLog("afterFlush function", e);
          }
        }
      }
      finishedTry = true;
    } finally {
      if (! finishedTry) {
        // we're erroring
        inFlush = false; // needed before calling `Deps.flush()` again
        Deps.flush({_throwFirstError: false}); // finish flushing
      }
      willFlush = false;
      inFlush = false;
    }
  },

  // http://docs.meteor.com/#deps_autorun
  //
  // Run f(). Record its dependencies. Rerun it whenever the
  // dependencies change.
  //
  // Returns a new Computation, which is also passed to f.
  //
  // Links the computation to the current computation
  // so that it is stopped if the current computation is invalidated.
  autorun: function (f) {
    if (typeof f !== 'function')
      throw new Error('Deps.autorun requires a function argument');

    constructingComputation = true;
    var c = new Deps.Computation(f, Deps.currentComputation);

    if (Deps.active)
      Deps.onInvalidate(function () {
        c.stop();
      });

    return c;
  },

  // http://docs.meteor.com/#deps_nonreactive
  //
  // Run `f` with no current computation, returning the return value
  // of `f`.  Used to turn off reactivity for the duration of `f`,
  // so that reactive data sources accessed by `f` will not result in any
  // computations being invalidated.
  nonreactive: function (f) {
    var previous = Deps.currentComputation;
    setCurrentComputation(null);
    try {
      return f();
    } finally {
      setCurrentComputation(previous);
    }
  },

  // http://docs.meteor.com/#deps_oninvalidate
  onInvalidate: function (f) {
    if (! Deps.active)
      throw new Error("Deps.onInvalidate requires a currentComputation");

    Deps.currentComputation.onInvalidate(f);
  },

  // http://docs.meteor.com/#deps_afterflush
  afterFlush: function (f) {
    afterFlushCallbacks.push(f);
    requireFlush();
  }
});


}).call(this);






(function () {

                                                                                //
// Deprecated (Deps-recated?) functions.

// These functions used to be on the Meteor object (and worked slightly
// differently).
// XXX COMPAT WITH 0.5.7
Meteor.flush = Deps.flush;
Meteor.autorun = Deps.autorun;

// We used to require a special "autosubscribe" call to reactively subscribe to
// things. Now, it works with autorun.
// XXX COMPAT WITH 0.5.4
Meteor.autosubscribe = Deps.autorun;

// This Deps API briefly existed in 0.5.8 and 0.5.9
// XXX COMPAT WITH 0.5.9
Deps.depend = function (d) {
  return d.depend();
};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.deps = {
  Deps: Deps
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var JSON = Package.json.JSON;
var _ = Package.underscore._;

/* Package-scope variables */
var EJSON, EJSONTest, base64Encode, base64Decode;

(function () {

                                                                                                //
EJSON = {};
EJSONTest = {};

var customTypes = {};
// Add a custom type, using a method of your choice to get to and
// from a basic JSON-able representation.  The factory argument
// is a function of JSON-able --> your object
// The type you add must have:
// - A toJSONValue() method, so that Meteor can serialize it
// - a typeName() method, to show how to look it up in our type table.
// It is okay if these methods are monkey-patched on.
// EJSON.clone will use toJSONValue and the given factory to produce
// a clone, but you may specify a method clone() that will be
// used instead.
// Similarly, EJSON.equals will use toJSONValue to make comparisons,
// but you may provide a method equals() instead.
//
EJSON.addType = function (name, factory) {
  if (_.has(customTypes, name))
    throw new Error("Type " + name + " already present");
  customTypes[name] = factory;
};

var isInfOrNan = function (obj) {
  return _.isNaN(obj) || obj === Infinity || obj === -Infinity;
};

var builtinConverters = [
  { // Date
    matchJSONValue: function (obj) {
      return _.has(obj, '$date') && _.size(obj) === 1;
    },
    matchObject: function (obj) {
      return obj instanceof Date;
    },
    toJSONValue: function (obj) {
      return {$date: obj.getTime()};
    },
    fromJSONValue: function (obj) {
      return new Date(obj.$date);
    }
  },
  { // NaN, Inf, -Inf. (These are the only objects with typeof !== 'object'
    // which we match.)
    matchJSONValue: function (obj) {
      return _.has(obj, '$InfNaN') && _.size(obj) === 1;
    },
    matchObject: isInfOrNan,
    toJSONValue: function (obj) {
      var sign;
      if (_.isNaN(obj))
        sign = 0;
      else if (obj === Infinity)
        sign = 1;
      else
        sign = -1;
      return {$InfNaN: sign};
    },
    fromJSONValue: function (obj) {
      return obj.$InfNaN/0;
    }
  },
  { // Binary
    matchJSONValue: function (obj) {
      return _.has(obj, '$binary') && _.size(obj) === 1;
    },
    matchObject: function (obj) {
      return typeof Uint8Array !== 'undefined' && obj instanceof Uint8Array
        || (obj && _.has(obj, '$Uint8ArrayPolyfill'));
    },
    toJSONValue: function (obj) {
      return {$binary: base64Encode(obj)};
    },
    fromJSONValue: function (obj) {
      return base64Decode(obj.$binary);
    }
  },
  { // Escaping one level
    matchJSONValue: function (obj) {
      return _.has(obj, '$escape') && _.size(obj) === 1;
    },
    matchObject: function (obj) {
      if (_.isEmpty(obj) || _.size(obj) > 2) {
        return false;
      }
      return _.any(builtinConverters, function (converter) {
        return converter.matchJSONValue(obj);
      });
    },
    toJSONValue: function (obj) {
      var newObj = {};
      _.each(obj, function (value, key) {
        newObj[key] = EJSON.toJSONValue(value);
      });
      return {$escape: newObj};
    },
    fromJSONValue: function (obj) {
      var newObj = {};
      _.each(obj.$escape, function (value, key) {
        newObj[key] = EJSON.fromJSONValue(value);
      });
      return newObj;
    }
  },
  { // Custom
    matchJSONValue: function (obj) {
      return _.has(obj, '$type') && _.has(obj, '$value') && _.size(obj) === 2;
    },
    matchObject: function (obj) {
      return EJSON._isCustomType(obj);
    },
    toJSONValue: function (obj) {
      var jsonValue = Meteor._noYieldsAllowed(function () {
        return obj.toJSONValue();
      });
      return {$type: obj.typeName(), $value: jsonValue};
    },
    fromJSONValue: function (obj) {
      var typeName = obj.$type;
      if (!_.has(customTypes, typeName))
        throw new Error("Custom EJSON type " + typeName + " is not defined");
      var converter = customTypes[typeName];
      return Meteor._noYieldsAllowed(function () {
        return converter(obj.$value);
      });
    }
  }
];

EJSON._isCustomType = function (obj) {
  return obj &&
    typeof obj.toJSONValue === 'function' &&
    typeof obj.typeName === 'function' &&
    _.has(customTypes, obj.typeName());
};


// for both arrays and objects, in-place modification.
var adjustTypesToJSONValue =
EJSON._adjustTypesToJSONValue = function (obj) {
  // Is it an atom that we need to adjust?
  if (obj === null)
    return null;
  var maybeChanged = toJSONValueHelper(obj);
  if (maybeChanged !== undefined)
    return maybeChanged;

  // Other atoms are unchanged.
  if (typeof obj !== 'object')
    return obj;

  // Iterate over array or object structure.
  _.each(obj, function (value, key) {
    if (typeof value !== 'object' && value !== undefined &&
        !isInfOrNan(value))
      return; // continue

    var changed = toJSONValueHelper(value);
    if (changed) {
      obj[key] = changed;
      return; // on to the next key
    }
    // if we get here, value is an object but not adjustable
    // at this level.  recurse.
    adjustTypesToJSONValue(value);
  });
  return obj;
};

// Either return the JSON-compatible version of the argument, or undefined (if
// the item isn't itself replaceable, but maybe some fields in it are)
var toJSONValueHelper = function (item) {
  for (var i = 0; i < builtinConverters.length; i++) {
    var converter = builtinConverters[i];
    if (converter.matchObject(item)) {
      return converter.toJSONValue(item);
    }
  }
  return undefined;
};

EJSON.toJSONValue = function (item) {
  var changed = toJSONValueHelper(item);
  if (changed !== undefined)
    return changed;
  if (typeof item === 'object') {
    item = EJSON.clone(item);
    adjustTypesToJSONValue(item);
  }
  return item;
};

// for both arrays and objects. Tries its best to just
// use the object you hand it, but may return something
// different if the object you hand it itself needs changing.
//
var adjustTypesFromJSONValue =
EJSON._adjustTypesFromJSONValue = function (obj) {
  if (obj === null)
    return null;
  var maybeChanged = fromJSONValueHelper(obj);
  if (maybeChanged !== obj)
    return maybeChanged;

  // Other atoms are unchanged.
  if (typeof obj !== 'object')
    return obj;

  _.each(obj, function (value, key) {
    if (typeof value === 'object') {
      var changed = fromJSONValueHelper(value);
      if (value !== changed) {
        obj[key] = changed;
        return;
      }
      // if we get here, value is an object but not adjustable
      // at this level.  recurse.
      adjustTypesFromJSONValue(value);
    }
  });
  return obj;
};

// Either return the argument changed to have the non-json
// rep of itself (the Object version) or the argument itself.

// DOES NOT RECURSE.  For actually getting the fully-changed value, use
// EJSON.fromJSONValue
var fromJSONValueHelper = function (value) {
  if (typeof value === 'object' && value !== null) {
    if (_.size(value) <= 2
        && _.all(value, function (v, k) {
          return typeof k === 'string' && k.substr(0, 1) === '$';
        })) {
      for (var i = 0; i < builtinConverters.length; i++) {
        var converter = builtinConverters[i];
        if (converter.matchJSONValue(value)) {
          return converter.fromJSONValue(value);
        }
      }
    }
  }
  return value;
};

EJSON.fromJSONValue = function (item) {
  var changed = fromJSONValueHelper(item);
  if (changed === item && typeof item === 'object') {
    item = EJSON.clone(item);
    adjustTypesFromJSONValue(item);
    return item;
  } else {
    return changed;
  }
};

EJSON.stringify = function (item, options) {
  var json = EJSON.toJSONValue(item);
  if (options && (options.canonical || options.indent)) {
    return EJSON._canonicalStringify(json, options);
  } else {
    return JSON.stringify(json);
  }
};

EJSON.parse = function (item) {
  if (typeof item !== 'string')
    throw new Error("EJSON.parse argument should be a string");
  return EJSON.fromJSONValue(JSON.parse(item));
};

EJSON.isBinary = function (obj) {
  return !!((typeof Uint8Array !== 'undefined' && obj instanceof Uint8Array) ||
    (obj && obj.$Uint8ArrayPolyfill));
};

EJSON.equals = function (a, b, options) {
  var i;
  var keyOrderSensitive = !!(options && options.keyOrderSensitive);
  if (a === b)
    return true;
  if (_.isNaN(a) && _.isNaN(b))
    return true; // This differs from the IEEE spec for NaN equality, b/c we don't want
                 // anything ever with a NaN to be poisoned from becoming equal to anything.
  if (!a || !b) // if either one is falsy, they'd have to be === to be equal
    return false;
  if (!(typeof a === 'object' && typeof b === 'object'))
    return false;
  if (a instanceof Date && b instanceof Date)
    return a.valueOf() === b.valueOf();
  if (EJSON.isBinary(a) && EJSON.isBinary(b)) {
    if (a.length !== b.length)
      return false;
    for (i = 0; i < a.length; i++) {
      if (a[i] !== b[i])
        return false;
    }
    return true;
  }
  if (typeof (a.equals) === 'function')
    return a.equals(b, options);
  if (typeof (b.equals) === 'function')
    return b.equals(a, options);
  if (a instanceof Array) {
    if (!(b instanceof Array))
      return false;
    if (a.length !== b.length)
      return false;
    for (i = 0; i < a.length; i++) {
      if (!EJSON.equals(a[i], b[i], options))
        return false;
    }
    return true;
  }
  // fallback for custom types that don't implement their own equals
  switch (EJSON._isCustomType(a) + EJSON._isCustomType(b)) {
    case 1: return false;
    case 2: return EJSON.equals(EJSON.toJSONValue(a), EJSON.toJSONValue(b));
  }
  // fall back to structural equality of objects
  var ret;
  if (keyOrderSensitive) {
    var bKeys = [];
    _.each(b, function (val, x) {
        bKeys.push(x);
    });
    i = 0;
    ret = _.all(a, function (val, x) {
      if (i >= bKeys.length) {
        return false;
      }
      if (x !== bKeys[i]) {
        return false;
      }
      if (!EJSON.equals(val, b[bKeys[i]], options)) {
        return false;
      }
      i++;
      return true;
    });
    return ret && i === bKeys.length;
  } else {
    i = 0;
    ret = _.all(a, function (val, key) {
      if (!_.has(b, key)) {
        return false;
      }
      if (!EJSON.equals(val, b[key], options)) {
        return false;
      }
      i++;
      return true;
    });
    return ret && _.size(b) === i;
  }
};

EJSON.clone = function (v) {
  var ret;
  if (typeof v !== "object")
    return v;
  if (v === null)
    return null; // null has typeof "object"
  if (v instanceof Date)
    return new Date(v.getTime());
  // RegExps are not really EJSON elements (eg we don't define a serialization
  // for them), but they're immutable anyway, so we can support them in clone.
  if (v instanceof RegExp)
    return v;
  if (EJSON.isBinary(v)) {
    ret = EJSON.newBinary(v.length);
    for (var i = 0; i < v.length; i++) {
      ret[i] = v[i];
    }
    return ret;
  }
  // XXX: Use something better than underscore's isArray
  if (_.isArray(v) || _.isArguments(v)) {
    // For some reason, _.map doesn't work in this context on Opera (weird test
    // failures).
    ret = [];
    for (i = 0; i < v.length; i++)
      ret[i] = EJSON.clone(v[i]);
    return ret;
  }
  // handle general user-defined typed Objects if they have a clone method
  if (typeof v.clone === 'function') {
    return v.clone();
  }
  // handle other custom types
  if (EJSON._isCustomType(v)) {
    return EJSON.fromJSONValue(EJSON.clone(EJSON.toJSONValue(v)), true);
  }
  // handle other objects
  ret = {};
  _.each(v, function (value, key) {
    ret[key] = EJSON.clone(value);
  });
  return ret;
};


}).call(this);






(function () {

                                                                                                //
// Based on json2.js from https://github.com/douglascrockford/JSON-js
//
//    json2.js
//    2012-10-08
//
//    Public Domain.
//
//    NO WARRANTY EXPRESSED OR IMPLIED. USE AT YOUR OWN RISK.

function quote(string) {
  return JSON.stringify(string);
}

var str = function (key, holder, singleIndent, outerIndent, canonical) {

  // Produce a string from holder[key].

  var i;          // The loop counter.
  var k;          // The member key.
  var v;          // The member value.
  var length;
  var innerIndent = outerIndent;
  var partial;
  var value = holder[key];

  // What happens next depends on the value's type.

  switch (typeof value) {
  case 'string':
    return quote(value);
  case 'number':
    // JSON numbers must be finite. Encode non-finite numbers as null.
    return isFinite(value) ? String(value) : 'null';
  case 'boolean':
    return String(value);
  // If the type is 'object', we might be dealing with an object or an array or
  // null.
  case 'object':
    // Due to a specification blunder in ECMAScript, typeof null is 'object',
    // so watch out for that case.
    if (!value) {
      return 'null';
    }
    // Make an array to hold the partial results of stringifying this object value.
    innerIndent = outerIndent + singleIndent;
    partial = [];

    // Is the value an array?
    if (_.isArray(value) || _.isArguments(value)) {

      // The value is an array. Stringify every element. Use null as a placeholder
      // for non-JSON values.

      length = value.length;
      for (i = 0; i < length; i += 1) {
        partial[i] = str(i, value, singleIndent, innerIndent, canonical) || 'null';
      }

      // Join all of the elements together, separated with commas, and wrap them in
      // brackets.

      if (partial.length === 0) {
        v = '[]';
      } else if (innerIndent) {
        v = '[\n' + innerIndent + partial.join(',\n' + innerIndent) + '\n' + outerIndent + ']';
      } else {
        v = '[' + partial.join(',') + ']';
      }
      return v;
    }


    // Iterate through all of the keys in the object.
    var keys = _.keys(value);
    if (canonical)
      keys = keys.sort();
    _.each(keys, function (k) {
      v = str(k, value, singleIndent, innerIndent, canonical);
      if (v) {
        partial.push(quote(k) + (innerIndent ? ': ' : ':') + v);
      }
    });


    // Join all of the member texts together, separated with commas,
    // and wrap them in braces.

    if (partial.length === 0) {
      v = '{}';
    } else if (innerIndent) {
      v = '{\n' + innerIndent + partial.join(',\n' + innerIndent) + '\n' + outerIndent + '}';
    } else {
      v = '{' + partial.join(',') + '}';
    }
    return v;
  }
}

// If the JSON object does not yet have a stringify method, give it one.

EJSON._canonicalStringify = function (value, options) {
  // Make a fake root object containing our value under the key of ''.
  // Return the result of stringifying the value.
  options = _.extend({
    indent: "",
    canonical: false
  }, options);
  if (options.indent === true) {
    options.indent = "  ";
  } else if (typeof options.indent === 'number') {
    var newIndent = "";
    for (var i = 0; i < options.indent; i++) {
      newIndent += ' ';
    }
    options.indent = newIndent;
  }
  return str('', {'': value}, options.indent, "", options.canonical);
};


}).call(this);






(function () {

                                                                                                //
// Base 64 encoding

var BASE_64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

var BASE_64_VALS = {};

for (var i = 0; i < BASE_64_CHARS.length; i++) {
  BASE_64_VALS[BASE_64_CHARS.charAt(i)] = i;
};

base64Encode = function (array) {
  var answer = [];
  var a = null;
  var b = null;
  var c = null;
  var d = null;
  for (var i = 0; i < array.length; i++) {
    switch (i % 3) {
    case 0:
      a = (array[i] >> 2) & 0x3F;
      b = (array[i] & 0x03) << 4;
      break;
    case 1:
      b = b | (array[i] >> 4) & 0xF;
      c = (array[i] & 0xF) << 2;
      break;
    case 2:
      c = c | (array[i] >> 6) & 0x03;
      d = array[i] & 0x3F;
      answer.push(getChar(a));
      answer.push(getChar(b));
      answer.push(getChar(c));
      answer.push(getChar(d));
      a = null;
      b = null;
      c = null;
      d = null;
      break;
    }
  }
  if (a != null) {
    answer.push(getChar(a));
    answer.push(getChar(b));
    if (c == null)
      answer.push('=');
    else
      answer.push(getChar(c));
    if (d == null)
      answer.push('=');
  }
  return answer.join("");
};

var getChar = function (val) {
  return BASE_64_CHARS.charAt(val);
};

var getVal = function (ch) {
  if (ch === '=') {
    return -1;
  }
  return BASE_64_VALS[ch];
};

EJSON.newBinary = function (len) {
  if (typeof Uint8Array === 'undefined' || typeof ArrayBuffer === 'undefined') {
    var ret = [];
    for (var i = 0; i < len; i++) {
      ret.push(0);
    }
    ret.$Uint8ArrayPolyfill = true;
    return ret;
  }
  return new Uint8Array(new ArrayBuffer(len));
};

base64Decode = function (str) {
  var len = Math.floor((str.length*3)/4);
  if (str.charAt(str.length - 1) == '=') {
    len--;
    if (str.charAt(str.length - 2) == '=')
      len--;
  }
  var arr = EJSON.newBinary(len);

  var one = null;
  var two = null;
  var three = null;

  var j = 0;

  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i);
    var v = getVal(c);
    switch (i % 4) {
    case 0:
      if (v < 0)
        throw new Error('invalid base64 string');
      one = v << 2;
      break;
    case 1:
      if (v < 0)
        throw new Error('invalid base64 string');
      one = one | (v >> 4);
      arr[j++] = one;
      two = (v & 0x0F) << 4;
      break;
    case 2:
      if (v >= 0) {
        two = two | (v >> 2);
        arr[j++] = two;
        three = (v & 0x03) << 6;
      }
      break;
    case 3:
      if (v >= 0) {
        arr[j++] = three | v;
      }
      break;
    }
  }
  return arr;
};

EJSONTest.base64Encode = base64Encode;

EJSONTest.base64Decode = base64Decode;


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.ejson = {
  EJSON: EJSON,
  EJSONTest: EJSONTest
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;

/* Package-scope variables */
var GeoJSON, module;

(function () {

                                                                                                           //
// Define an object named exports. This will cause geojson-utils.js to put `gju`
// as a field on it, instead of in the global namespace.  See also post.js.
module = {exports:{}};



}).call(this);






(function () {

                                                                                                           //
(function () {
  var gju = {};

  // Export the geojson object for **CommonJS**
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = gju;
  }

  // adapted from http://www.kevlindev.com/gui/math/intersection/Intersection.js
  gju.lineStringsIntersect = function (l1, l2) {
    var intersects = [];
    for (var i = 0; i <= l1.coordinates.length - 2; ++i) {
      for (var j = 0; j <= l2.coordinates.length - 2; ++j) {
        var a1 = {
          x: l1.coordinates[i][1],
          y: l1.coordinates[i][0]
        },
          a2 = {
            x: l1.coordinates[i + 1][1],
            y: l1.coordinates[i + 1][0]
          },
          b1 = {
            x: l2.coordinates[j][1],
            y: l2.coordinates[j][0]
          },
          b2 = {
            x: l2.coordinates[j + 1][1],
            y: l2.coordinates[j + 1][0]
          },
          ua_t = (b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x),
          ub_t = (a2.x - a1.x) * (a1.y - b1.y) - (a2.y - a1.y) * (a1.x - b1.x),
          u_b = (b2.y - b1.y) * (a2.x - a1.x) - (b2.x - b1.x) * (a2.y - a1.y);
        if (u_b != 0) {
          var ua = ua_t / u_b,
            ub = ub_t / u_b;
          if (0 <= ua && ua <= 1 && 0 <= ub && ub <= 1) {
            intersects.push({
              'type': 'Point',
              'coordinates': [a1.x + ua * (a2.x - a1.x), a1.y + ua * (a2.y - a1.y)]
            });
          }
        }
      }
    }
    if (intersects.length == 0) intersects = false;
    return intersects;
  }

  // Bounding Box

  function boundingBoxAroundPolyCoords (coords) {
    var xAll = [], yAll = []

    for (var i = 0; i < coords[0].length; i++) {
      xAll.push(coords[0][i][1])
      yAll.push(coords[0][i][0])
    }

    xAll = xAll.sort(function (a,b) { return a - b })
    yAll = yAll.sort(function (a,b) { return a - b })

    return [ [xAll[0], yAll[0]], [xAll[xAll.length - 1], yAll[yAll.length - 1]] ]
  }

  gju.pointInBoundingBox = function (point, bounds) {
    return !(point.coordinates[1] < bounds[0][0] || point.coordinates[1] > bounds[1][0] || point.coordinates[0] < bounds[0][1] || point.coordinates[0] > bounds[1][1]) 
  }

  // Point in Polygon
  // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html#Listing the Vertices

  function pnpoly (x,y,coords) {
    var vert = [ [0,0] ]

    for (var i = 0; i < coords.length; i++) {
      for (var j = 0; j < coords[i].length; j++) {
        vert.push(coords[i][j])
      }
      vert.push([0,0])
    }

    var inside = false
    for (var i = 0, j = vert.length - 1; i < vert.length; j = i++) {
      if (((vert[i][0] > y) != (vert[j][0] > y)) && (x < (vert[j][1] - vert[i][1]) * (y - vert[i][0]) / (vert[j][0] - vert[i][0]) + vert[i][1])) inside = !inside
    }

    return inside
  }

  gju.pointInPolygon = function (p, poly) {
    var coords = (poly.type == "Polygon") ? [ poly.coordinates ] : poly.coordinates

    var insideBox = false
    for (var i = 0; i < coords.length; i++) {
      if (gju.pointInBoundingBox(p, boundingBoxAroundPolyCoords(coords[i]))) insideBox = true
    }
    if (!insideBox) return false

    var insidePoly = false
    for (var i = 0; i < coords.length; i++) {
      if (pnpoly(p.coordinates[1], p.coordinates[0], coords[i])) insidePoly = true
    }

    return insidePoly
  }

  gju.numberToRadius = function (number) {
    return number * Math.PI / 180;
  }

  gju.numberToDegree = function (number) {
    return number * 180 / Math.PI;
  }

  // written with help from @tautologe
  gju.drawCircle = function (radiusInMeters, centerPoint, steps) {
    var center = [centerPoint.coordinates[1], centerPoint.coordinates[0]],
      dist = (radiusInMeters / 1000) / 6371,
      // convert meters to radiant
      radCenter = [gju.numberToRadius(center[0]), gju.numberToRadius(center[1])],
      steps = steps || 15,
      // 15 sided circle
      poly = [[center[0], center[1]]];
    for (var i = 0; i < steps; i++) {
      var brng = 2 * Math.PI * i / steps;
      var lat = Math.asin(Math.sin(radCenter[0]) * Math.cos(dist)
              + Math.cos(radCenter[0]) * Math.sin(dist) * Math.cos(brng));
      var lng = radCenter[1] + Math.atan2(Math.sin(brng) * Math.sin(dist) * Math.cos(radCenter[0]),
                                          Math.cos(dist) - Math.sin(radCenter[0]) * Math.sin(lat));
      poly[i] = [];
      poly[i][1] = gju.numberToDegree(lat);
      poly[i][0] = gju.numberToDegree(lng);
    }
    return {
      "type": "Polygon",
      "coordinates": [poly]
    };
  }

  // assumes rectangle starts at lower left point
  gju.rectangleCentroid = function (rectangle) {
    var bbox = rectangle.coordinates[0];
    var xmin = bbox[0][0],
      ymin = bbox[0][1],
      xmax = bbox[2][0],
      ymax = bbox[2][1];
    var xwidth = xmax - xmin;
    var ywidth = ymax - ymin;
    return {
      'type': 'Point',
      'coordinates': [xmin + xwidth / 2, ymin + ywidth / 2]
    };
  }

  // from http://www.movable-type.co.uk/scripts/latlong.html
  gju.pointDistance = function (pt1, pt2) {
    var lon1 = pt1.coordinates[0],
      lat1 = pt1.coordinates[1],
      lon2 = pt2.coordinates[0],
      lat2 = pt2.coordinates[1],
      dLat = gju.numberToRadius(lat2 - lat1),
      dLon = gju.numberToRadius(lon2 - lon1),
      a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(gju.numberToRadius(lat1))
        * Math.cos(gju.numberToRadius(lat2)) * Math.pow(Math.sin(dLon / 2), 2),
      c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    // Earth radius is 6371 km
    return (6371 * c) * 1000; // returns meters
  },

  // checks if geometry lies entirely within a circle
  // works with Point, LineString, Polygon
  gju.geometryWithinRadius = function (geometry, center, radius) {
    if (geometry.type == 'Point') {
      return gju.pointDistance(geometry, center) <= radius;
    } else if (geometry.type == 'LineString' || geometry.type == 'Polygon') {
      var point = {};
      var coordinates;
      if (geometry.type == 'Polygon') {
        // it's enough to check the exterior ring of the Polygon
        coordinates = geometry.coordinates[0];
      } else {
        coordinates = geometry.coordinates;
      }
      for (var i in coordinates) {
        point.coordinates = coordinates[i];
        if (gju.pointDistance(point, center) > radius) {
          return false;
        }
      }
    }
    return true;
  }

  // adapted from http://paulbourke.net/geometry/polyarea/javascript.txt
  gju.area = function (polygon) {
    var area = 0;
    // TODO: polygon holes at coordinates[1]
    var points = polygon.coordinates[0];
    var j = points.length - 1;
    var p1, p2;

    for (var i = 0; i < points.length; j = i++) {
      var p1 = {
        x: points[i][1],
        y: points[i][0]
      };
      var p2 = {
        x: points[j][1],
        y: points[j][0]
      };
      area += p1.x * p2.y;
      area -= p1.y * p2.x;
    }

    area /= 2;
    return area;
  },

  // adapted from http://paulbourke.net/geometry/polyarea/javascript.txt
  gju.centroid = function (polygon) {
    var f, x = 0,
      y = 0;
    // TODO: polygon holes at coordinates[1]
    var points = polygon.coordinates[0];
    var j = points.length - 1;
    var p1, p2;

    for (var i = 0; i < points.length; j = i++) {
      var p1 = {
        x: points[i][1],
        y: points[i][0]
      };
      var p2 = {
        x: points[j][1],
        y: points[j][0]
      };
      f = p1.x * p2.y - p2.x * p1.y;
      x += (p1.x + p2.x) * f;
      y += (p1.y + p2.y) * f;
    }

    f = gju.area(polygon) * 6;
    return {
      'type': 'Point',
      'coordinates': [y / f, x / f]
    };
  },

  gju.simplify = function (source, kink) { /* source[] array of geojson points */
    /* kink	in metres, kinks above this depth kept  */
    /* kink depth is the height of the triangle abc where a-b and b-c are two consecutive line segments */
    kink = kink || 20;
    source = source.map(function (o) {
      return {
        lng: o.coordinates[0],
        lat: o.coordinates[1]
      }
    });

    var n_source, n_stack, n_dest, start, end, i, sig;
    var dev_sqr, max_dev_sqr, band_sqr;
    var x12, y12, d12, x13, y13, d13, x23, y23, d23;
    var F = (Math.PI / 180.0) * 0.5;
    var index = new Array(); /* aray of indexes of source points to include in the reduced line */
    var sig_start = new Array(); /* indices of start & end of working section */
    var sig_end = new Array();

    /* check for simple cases */

    if (source.length < 3) return (source); /* one or two points */

    /* more complex case. initialize stack */

    n_source = source.length;
    band_sqr = kink * 360.0 / (2.0 * Math.PI * 6378137.0); /* Now in degrees */
    band_sqr *= band_sqr;
    n_dest = 0;
    sig_start[0] = 0;
    sig_end[0] = n_source - 1;
    n_stack = 1;

    /* while the stack is not empty  ... */
    while (n_stack > 0) {

      /* ... pop the top-most entries off the stacks */

      start = sig_start[n_stack - 1];
      end = sig_end[n_stack - 1];
      n_stack--;

      if ((end - start) > 1) { /* any intermediate points ? */

        /* ... yes, so find most deviant intermediate point to
        either side of line joining start & end points */

        x12 = (source[end].lng() - source[start].lng());
        y12 = (source[end].lat() - source[start].lat());
        if (Math.abs(x12) > 180.0) x12 = 360.0 - Math.abs(x12);
        x12 *= Math.cos(F * (source[end].lat() + source[start].lat())); /* use avg lat to reduce lng */
        d12 = (x12 * x12) + (y12 * y12);

        for (i = start + 1, sig = start, max_dev_sqr = -1.0; i < end; i++) {

          x13 = source[i].lng() - source[start].lng();
          y13 = source[i].lat() - source[start].lat();
          if (Math.abs(x13) > 180.0) x13 = 360.0 - Math.abs(x13);
          x13 *= Math.cos(F * (source[i].lat() + source[start].lat()));
          d13 = (x13 * x13) + (y13 * y13);

          x23 = source[i].lng() - source[end].lng();
          y23 = source[i].lat() - source[end].lat();
          if (Math.abs(x23) > 180.0) x23 = 360.0 - Math.abs(x23);
          x23 *= Math.cos(F * (source[i].lat() + source[end].lat()));
          d23 = (x23 * x23) + (y23 * y23);

          if (d13 >= (d12 + d23)) dev_sqr = d23;
          else if (d23 >= (d12 + d13)) dev_sqr = d13;
          else dev_sqr = (x13 * y12 - y13 * x12) * (x13 * y12 - y13 * x12) / d12; // solve triangle
          if (dev_sqr > max_dev_sqr) {
            sig = i;
            max_dev_sqr = dev_sqr;
          }
        }

        if (max_dev_sqr < band_sqr) { /* is there a sig. intermediate point ? */
          /* ... no, so transfer current start point */
          index[n_dest] = start;
          n_dest++;
        } else { /* ... yes, so push two sub-sections on stack for further processing */
          n_stack++;
          sig_start[n_stack - 1] = sig;
          sig_end[n_stack - 1] = end;
          n_stack++;
          sig_start[n_stack - 1] = start;
          sig_end[n_stack - 1] = sig;
        }
      } else { /* ... no intermediate points, so transfer current start point */
        index[n_dest] = start;
        n_dest++;
      }
    }

    /* transfer last point */
    index[n_dest] = n_source - 1;
    n_dest++;

    /* make return array */
    var r = new Array();
    for (var i = 0; i < n_dest; i++)
      r.push(source[index[i]]);

    return r.map(function (o) {
      return {
        type: "Point",
        coordinates: [o.lng, o.lat]
      }
    });
  }

  // http://www.movable-type.co.uk/scripts/latlong.html#destPoint
  gju.destinationPoint = function (pt, brng, dist) {
    dist = dist/6371;  // convert dist to angular distance in radians
    brng = gju.numberToRadius(brng);

    var lat1 = gju.numberToRadius(pt.coordinates[0]);
    var lon1 = gju.numberToRadius(pt.coordinates[1]);

    var lat2 = Math.asin( Math.sin(lat1)*Math.cos(dist) +
                          Math.cos(lat1)*Math.sin(dist)*Math.cos(brng) );
    var lon2 = lon1 + Math.atan2(Math.sin(brng)*Math.sin(dist)*Math.cos(lat1),
                                 Math.cos(dist)-Math.sin(lat1)*Math.sin(lat2));
    lon2 = (lon2+3*Math.PI) % (2*Math.PI) - Math.PI;  // normalise to -180..+180º

    return {
      'type': 'Point',
      'coordinates': [gju.numberToDegree(lat2), gju.numberToDegree(lon2)]
    };
  };

})();


}).call(this);






(function () {

                                                                                                           //
// This exports object was created in pre.js.  Now copy the `exports` object
// from it into the package-scope variable `GeoJSON`, which will get exported.
GeoJSON = module.exports;



}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['geojson-utils'] = {
  GeoJSON: GeoJSON
};

})();

/* Imports for global scope */

Template = Package.templating.Template;
$ = Package.jquery.$;
jQuery = Package.jquery.jQuery;
Meteor = Package.meteor.Meteor;
UI = Package.ui.UI;
Handlebars = Package.ui.Handlebars;
Spacebars = Package.spacebars.Spacebars;
HTMLTools = Package['html-tools'].HTMLTools;
HTML = Package.htmljs.HTML;



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var HTML = Package.htmljs.HTML;

/* Package-scope variables */
var HTMLTools, Scanner, makeRegexMatcher, getCharacterReference, getComment, getDoctype, getHTMLToken, getTagToken, TEMPLATE_TAG_POSITION, isLookingAtEndTag, codePointToString, getContent, getRCData;

(function () {

                                                                                                               //

HTMLTools = {};
HTMLTools.Parse = {};

var asciiLowerCase = HTMLTools.asciiLowerCase = function (str) {
  return str.replace(/[A-Z]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) + 32);
  });
};

var svgCamelCaseAttributes = 'attributeName attributeType baseFrequency baseProfile calcMode clipPathUnits contentScriptType contentStyleType diffuseConstant edgeMode externalResourcesRequired filterRes filterUnits glyphRef glyphRef gradientTransform gradientTransform gradientUnits gradientUnits kernelMatrix kernelUnitLength kernelUnitLength kernelUnitLength keyPoints keySplines keyTimes lengthAdjust limitingConeAngle markerHeight markerUnits markerWidth maskContentUnits maskUnits numOctaves pathLength patternContentUnits patternTransform patternUnits pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio primitiveUnits refX refY repeatCount repeatDur requiredExtensions requiredFeatures specularConstant specularExponent specularExponent spreadMethod spreadMethod startOffset stdDeviation stitchTiles surfaceScale surfaceScale systemLanguage tableValues targetX targetY textLength textLength viewBox viewTarget xChannelSelector yChannelSelector zoomAndPan'.split(' ');

var properAttributeCaseMap = (function (map) {
  for (var i = 0; i < svgCamelCaseAttributes.length; i++) {
    var a = svgCamelCaseAttributes[i];
    map[asciiLowerCase(a)] = a;
  }
  return map;
})({});

var properTagCaseMap = (function (map) {
  var knownElements = HTML.knownElementNames;
  for (var i = 0; i < knownElements.length; i++) {
    var a = knownElements[i];
    map[asciiLowerCase(a)] = a;
  }
  return map;
})({});

// Take a tag name in any case and make it the proper case for HTML.
//
// Modern browsers let you embed SVG in HTML, but SVG elements are special
// in that they have a case-sensitive DOM API (nodeName, getAttribute,
// setAttribute).  For example, it has to be `setAttribute("viewBox")`,
// not `"viewbox"`.  However, the browser's HTML parser is NOT case sensitive
// and will fix the case for you, so if you write `<svg viewbox="...">`
// you actually get a `"viewBox"` attribute.  Any HTML-parsing toolchain
// must do the same.
HTMLTools.properCaseTagName = function (name) {
  var lowered = asciiLowerCase(name);
  return properTagCaseMap.hasOwnProperty(lowered) ?
    properTagCaseMap[lowered] : lowered;
};

// See docs for properCaseTagName.
HTMLTools.properCaseAttributeName = function (name) {
  var lowered = asciiLowerCase(name);
  return properAttributeCaseMap.hasOwnProperty(lowered) ?
    properAttributeCaseMap[lowered] : lowered;
};


}).call(this);






(function () {

                                                                                                               //
// This is a Scanner class suitable for any parser/lexer/tokenizer.
//
// A Scanner has an immutable source document (string) `input` and a current
// position `pos`, an index into the string, which can be set at will.
//
// * `new Scanner(input)` - constructs a Scanner with source string `input`
// * `scanner.rest()` - returns the rest of the input after `pos`
// * `scanner.peek()` - returns the character at `pos`
// * `scanner.isEOF()` - true if `pos` is at or beyond the end of `input`
// * `scanner.fatal(msg)` - throw an error indicating a problem at `pos`

Scanner = HTMLTools.Scanner = function (input) {
  this.input = input; // public, read-only
  this.pos = 0; // public, read-write
};

Scanner.prototype.rest = function () {
  // Slicing a string is O(1) in modern JavaScript VMs (including old IE).
  return this.input.slice(this.pos);
};

Scanner.prototype.isEOF = function () {
  return this.pos >= this.input.length;
};

Scanner.prototype.fatal = function (msg) {
  // despite this default, you should always provide a message!
  msg = (msg || "Parse error");

  var CONTEXT_AMOUNT = 20;

  var input = this.input;
  var pos = this.pos;
  var pastInput = input.substring(pos - CONTEXT_AMOUNT - 1, pos);
  if (pastInput.length > CONTEXT_AMOUNT)
    pastInput = '...' + pastInput.substring(-CONTEXT_AMOUNT);

  var upcomingInput = input.substring(pos, pos + CONTEXT_AMOUNT + 1);
  if (upcomingInput.length > CONTEXT_AMOUNT)
    upcomingInput = upcomingInput.substring(0, CONTEXT_AMOUNT) + '...';

  var positionDisplay = ((pastInput + upcomingInput).replace(/\n/g, ' ') + '\n' +
                         (new Array(pastInput.length + 1).join(' ')) + "^");

  var e = new Error(msg + "\n" + positionDisplay);

  e.offset = pos;
  var allPastInput = input.substring(0, pos);
  e.line = (1 + (allPastInput.match(/\n/g) || []).length);
  e.col = (1 + pos - allPastInput.lastIndexOf('\n'));
  e.scanner = this;

  throw e;
};

// Peek at the next character.
//
// If `isEOF`, returns an empty string.
Scanner.prototype.peek = function () {
  return this.input.charAt(this.pos);
};

// Constructs a `getFoo` function where `foo` is specified with a regex.
// The regex should start with `^`.  The constructed function will return
// match group 1, if it exists and matches a non-empty string, or else
// the entire matched string (or null if there is no match).
//
// A `getFoo` function tries to match and consume a foo.  If it succeeds,
// the current position of the scanner is advanced.  If it fails, the
// current position is not advanced and a falsy value (typically null)
// is returned.
makeRegexMatcher = function (regex) {
  return function (scanner) {
    var match = regex.exec(scanner.rest());

    if (! match)
      return null;

    scanner.pos += match[0].length;
    return match[1] || match[0];
  };
};


}).call(this);






(function () {

                                                                                                               //

// http://www.whatwg.org/specs/web-apps/current-work/multipage/entities.json


// Note that some entities don't have a final semicolon!  These are used to
// make `&lt` (for example) with no semicolon a parse error but `&abcde` not.

var ENTITIES = {
  "&Aacute;": { "codepoints": [193], "characters": "\u00C1" },
  "&Aacute": { "codepoints": [193], "characters": "\u00C1" },
  "&aacute;": { "codepoints": [225], "characters": "\u00E1" },
  "&aacute": { "codepoints": [225], "characters": "\u00E1" },
  "&Abreve;": { "codepoints": [258], "characters": "\u0102" },
  "&abreve;": { "codepoints": [259], "characters": "\u0103" },
  "&ac;": { "codepoints": [8766], "characters": "\u223E" },
  "&acd;": { "codepoints": [8767], "characters": "\u223F" },
  "&acE;": { "codepoints": [8766, 819], "characters": "\u223E\u0333" },
  "&Acirc;": { "codepoints": [194], "characters": "\u00C2" },
  "&Acirc": { "codepoints": [194], "characters": "\u00C2" },
  "&acirc;": { "codepoints": [226], "characters": "\u00E2" },
  "&acirc": { "codepoints": [226], "characters": "\u00E2" },
  "&acute;": { "codepoints": [180], "characters": "\u00B4" },
  "&acute": { "codepoints": [180], "characters": "\u00B4" },
  "&Acy;": { "codepoints": [1040], "characters": "\u0410" },
  "&acy;": { "codepoints": [1072], "characters": "\u0430" },
  "&AElig;": { "codepoints": [198], "characters": "\u00C6" },
  "&AElig": { "codepoints": [198], "characters": "\u00C6" },
  "&aelig;": { "codepoints": [230], "characters": "\u00E6" },
  "&aelig": { "codepoints": [230], "characters": "\u00E6" },
  "&af;": { "codepoints": [8289], "characters": "\u2061" },
  "&Afr;": { "codepoints": [120068], "characters": "\uD835\uDD04" },
  "&afr;": { "codepoints": [120094], "characters": "\uD835\uDD1E" },
  "&Agrave;": { "codepoints": [192], "characters": "\u00C0" },
  "&Agrave": { "codepoints": [192], "characters": "\u00C0" },
  "&agrave;": { "codepoints": [224], "characters": "\u00E0" },
  "&agrave": { "codepoints": [224], "characters": "\u00E0" },
  "&alefsym;": { "codepoints": [8501], "characters": "\u2135" },
  "&aleph;": { "codepoints": [8501], "characters": "\u2135" },
  "&Alpha;": { "codepoints": [913], "characters": "\u0391" },
  "&alpha;": { "codepoints": [945], "characters": "\u03B1" },
  "&Amacr;": { "codepoints": [256], "characters": "\u0100" },
  "&amacr;": { "codepoints": [257], "characters": "\u0101" },
  "&amalg;": { "codepoints": [10815], "characters": "\u2A3F" },
  "&amp;": { "codepoints": [38], "characters": "\u0026" },
  "&amp": { "codepoints": [38], "characters": "\u0026" },
  "&AMP;": { "codepoints": [38], "characters": "\u0026" },
  "&AMP": { "codepoints": [38], "characters": "\u0026" },
  "&andand;": { "codepoints": [10837], "characters": "\u2A55" },
  "&And;": { "codepoints": [10835], "characters": "\u2A53" },
  "&and;": { "codepoints": [8743], "characters": "\u2227" },
  "&andd;": { "codepoints": [10844], "characters": "\u2A5C" },
  "&andslope;": { "codepoints": [10840], "characters": "\u2A58" },
  "&andv;": { "codepoints": [10842], "characters": "\u2A5A" },
  "&ang;": { "codepoints": [8736], "characters": "\u2220" },
  "&ange;": { "codepoints": [10660], "characters": "\u29A4" },
  "&angle;": { "codepoints": [8736], "characters": "\u2220" },
  "&angmsdaa;": { "codepoints": [10664], "characters": "\u29A8" },
  "&angmsdab;": { "codepoints": [10665], "characters": "\u29A9" },
  "&angmsdac;": { "codepoints": [10666], "characters": "\u29AA" },
  "&angmsdad;": { "codepoints": [10667], "characters": "\u29AB" },
  "&angmsdae;": { "codepoints": [10668], "characters": "\u29AC" },
  "&angmsdaf;": { "codepoints": [10669], "characters": "\u29AD" },
  "&angmsdag;": { "codepoints": [10670], "characters": "\u29AE" },
  "&angmsdah;": { "codepoints": [10671], "characters": "\u29AF" },
  "&angmsd;": { "codepoints": [8737], "characters": "\u2221" },
  "&angrt;": { "codepoints": [8735], "characters": "\u221F" },
  "&angrtvb;": { "codepoints": [8894], "characters": "\u22BE" },
  "&angrtvbd;": { "codepoints": [10653], "characters": "\u299D" },
  "&angsph;": { "codepoints": [8738], "characters": "\u2222" },
  "&angst;": { "codepoints": [197], "characters": "\u00C5" },
  "&angzarr;": { "codepoints": [9084], "characters": "\u237C" },
  "&Aogon;": { "codepoints": [260], "characters": "\u0104" },
  "&aogon;": { "codepoints": [261], "characters": "\u0105" },
  "&Aopf;": { "codepoints": [120120], "characters": "\uD835\uDD38" },
  "&aopf;": { "codepoints": [120146], "characters": "\uD835\uDD52" },
  "&apacir;": { "codepoints": [10863], "characters": "\u2A6F" },
  "&ap;": { "codepoints": [8776], "characters": "\u2248" },
  "&apE;": { "codepoints": [10864], "characters": "\u2A70" },
  "&ape;": { "codepoints": [8778], "characters": "\u224A" },
  "&apid;": { "codepoints": [8779], "characters": "\u224B" },
  "&apos;": { "codepoints": [39], "characters": "\u0027" },
  "&ApplyFunction;": { "codepoints": [8289], "characters": "\u2061" },
  "&approx;": { "codepoints": [8776], "characters": "\u2248" },
  "&approxeq;": { "codepoints": [8778], "characters": "\u224A" },
  "&Aring;": { "codepoints": [197], "characters": "\u00C5" },
  "&Aring": { "codepoints": [197], "characters": "\u00C5" },
  "&aring;": { "codepoints": [229], "characters": "\u00E5" },
  "&aring": { "codepoints": [229], "characters": "\u00E5" },
  "&Ascr;": { "codepoints": [119964], "characters": "\uD835\uDC9C" },
  "&ascr;": { "codepoints": [119990], "characters": "\uD835\uDCB6" },
  "&Assign;": { "codepoints": [8788], "characters": "\u2254" },
  "&ast;": { "codepoints": [42], "characters": "\u002A" },
  "&asymp;": { "codepoints": [8776], "characters": "\u2248" },
  "&asympeq;": { "codepoints": [8781], "characters": "\u224D" },
  "&Atilde;": { "codepoints": [195], "characters": "\u00C3" },
  "&Atilde": { "codepoints": [195], "characters": "\u00C3" },
  "&atilde;": { "codepoints": [227], "characters": "\u00E3" },
  "&atilde": { "codepoints": [227], "characters": "\u00E3" },
  "&Auml;": { "codepoints": [196], "characters": "\u00C4" },
  "&Auml": { "codepoints": [196], "characters": "\u00C4" },
  "&auml;": { "codepoints": [228], "characters": "\u00E4" },
  "&auml": { "codepoints": [228], "characters": "\u00E4" },
  "&awconint;": { "codepoints": [8755], "characters": "\u2233" },
  "&awint;": { "codepoints": [10769], "characters": "\u2A11" },
  "&backcong;": { "codepoints": [8780], "characters": "\u224C" },
  "&backepsilon;": { "codepoints": [1014], "characters": "\u03F6" },
  "&backprime;": { "codepoints": [8245], "characters": "\u2035" },
  "&backsim;": { "codepoints": [8765], "characters": "\u223D" },
  "&backsimeq;": { "codepoints": [8909], "characters": "\u22CD" },
  "&Backslash;": { "codepoints": [8726], "characters": "\u2216" },
  "&Barv;": { "codepoints": [10983], "characters": "\u2AE7" },
  "&barvee;": { "codepoints": [8893], "characters": "\u22BD" },
  "&barwed;": { "codepoints": [8965], "characters": "\u2305" },
  "&Barwed;": { "codepoints": [8966], "characters": "\u2306" },
  "&barwedge;": { "codepoints": [8965], "characters": "\u2305" },
  "&bbrk;": { "codepoints": [9141], "characters": "\u23B5" },
  "&bbrktbrk;": { "codepoints": [9142], "characters": "\u23B6" },
  "&bcong;": { "codepoints": [8780], "characters": "\u224C" },
  "&Bcy;": { "codepoints": [1041], "characters": "\u0411" },
  "&bcy;": { "codepoints": [1073], "characters": "\u0431" },
  "&bdquo;": { "codepoints": [8222], "characters": "\u201E" },
  "&becaus;": { "codepoints": [8757], "characters": "\u2235" },
  "&because;": { "codepoints": [8757], "characters": "\u2235" },
  "&Because;": { "codepoints": [8757], "characters": "\u2235" },
  "&bemptyv;": { "codepoints": [10672], "characters": "\u29B0" },
  "&bepsi;": { "codepoints": [1014], "characters": "\u03F6" },
  "&bernou;": { "codepoints": [8492], "characters": "\u212C" },
  "&Bernoullis;": { "codepoints": [8492], "characters": "\u212C" },
  "&Beta;": { "codepoints": [914], "characters": "\u0392" },
  "&beta;": { "codepoints": [946], "characters": "\u03B2" },
  "&beth;": { "codepoints": [8502], "characters": "\u2136" },
  "&between;": { "codepoints": [8812], "characters": "\u226C" },
  "&Bfr;": { "codepoints": [120069], "characters": "\uD835\uDD05" },
  "&bfr;": { "codepoints": [120095], "characters": "\uD835\uDD1F" },
  "&bigcap;": { "codepoints": [8898], "characters": "\u22C2" },
  "&bigcirc;": { "codepoints": [9711], "characters": "\u25EF" },
  "&bigcup;": { "codepoints": [8899], "characters": "\u22C3" },
  "&bigodot;": { "codepoints": [10752], "characters": "\u2A00" },
  "&bigoplus;": { "codepoints": [10753], "characters": "\u2A01" },
  "&bigotimes;": { "codepoints": [10754], "characters": "\u2A02" },
  "&bigsqcup;": { "codepoints": [10758], "characters": "\u2A06" },
  "&bigstar;": { "codepoints": [9733], "characters": "\u2605" },
  "&bigtriangledown;": { "codepoints": [9661], "characters": "\u25BD" },
  "&bigtriangleup;": { "codepoints": [9651], "characters": "\u25B3" },
  "&biguplus;": { "codepoints": [10756], "characters": "\u2A04" },
  "&bigvee;": { "codepoints": [8897], "characters": "\u22C1" },
  "&bigwedge;": { "codepoints": [8896], "characters": "\u22C0" },
  "&bkarow;": { "codepoints": [10509], "characters": "\u290D" },
  "&blacklozenge;": { "codepoints": [10731], "characters": "\u29EB" },
  "&blacksquare;": { "codepoints": [9642], "characters": "\u25AA" },
  "&blacktriangle;": { "codepoints": [9652], "characters": "\u25B4" },
  "&blacktriangledown;": { "codepoints": [9662], "characters": "\u25BE" },
  "&blacktriangleleft;": { "codepoints": [9666], "characters": "\u25C2" },
  "&blacktriangleright;": { "codepoints": [9656], "characters": "\u25B8" },
  "&blank;": { "codepoints": [9251], "characters": "\u2423" },
  "&blk12;": { "codepoints": [9618], "characters": "\u2592" },
  "&blk14;": { "codepoints": [9617], "characters": "\u2591" },
  "&blk34;": { "codepoints": [9619], "characters": "\u2593" },
  "&block;": { "codepoints": [9608], "characters": "\u2588" },
  "&bne;": { "codepoints": [61, 8421], "characters": "\u003D\u20E5" },
  "&bnequiv;": { "codepoints": [8801, 8421], "characters": "\u2261\u20E5" },
  "&bNot;": { "codepoints": [10989], "characters": "\u2AED" },
  "&bnot;": { "codepoints": [8976], "characters": "\u2310" },
  "&Bopf;": { "codepoints": [120121], "characters": "\uD835\uDD39" },
  "&bopf;": { "codepoints": [120147], "characters": "\uD835\uDD53" },
  "&bot;": { "codepoints": [8869], "characters": "\u22A5" },
  "&bottom;": { "codepoints": [8869], "characters": "\u22A5" },
  "&bowtie;": { "codepoints": [8904], "characters": "\u22C8" },
  "&boxbox;": { "codepoints": [10697], "characters": "\u29C9" },
  "&boxdl;": { "codepoints": [9488], "characters": "\u2510" },
  "&boxdL;": { "codepoints": [9557], "characters": "\u2555" },
  "&boxDl;": { "codepoints": [9558], "characters": "\u2556" },
  "&boxDL;": { "codepoints": [9559], "characters": "\u2557" },
  "&boxdr;": { "codepoints": [9484], "characters": "\u250C" },
  "&boxdR;": { "codepoints": [9554], "characters": "\u2552" },
  "&boxDr;": { "codepoints": [9555], "characters": "\u2553" },
  "&boxDR;": { "codepoints": [9556], "characters": "\u2554" },
  "&boxh;": { "codepoints": [9472], "characters": "\u2500" },
  "&boxH;": { "codepoints": [9552], "characters": "\u2550" },
  "&boxhd;": { "codepoints": [9516], "characters": "\u252C" },
  "&boxHd;": { "codepoints": [9572], "characters": "\u2564" },
  "&boxhD;": { "codepoints": [9573], "characters": "\u2565" },
  "&boxHD;": { "codepoints": [9574], "characters": "\u2566" },
  "&boxhu;": { "codepoints": [9524], "characters": "\u2534" },
  "&boxHu;": { "codepoints": [9575], "characters": "\u2567" },
  "&boxhU;": { "codepoints": [9576], "characters": "\u2568" },
  "&boxHU;": { "codepoints": [9577], "characters": "\u2569" },
  "&boxminus;": { "codepoints": [8863], "characters": "\u229F" },
  "&boxplus;": { "codepoints": [8862], "characters": "\u229E" },
  "&boxtimes;": { "codepoints": [8864], "characters": "\u22A0" },
  "&boxul;": { "codepoints": [9496], "characters": "\u2518" },
  "&boxuL;": { "codepoints": [9563], "characters": "\u255B" },
  "&boxUl;": { "codepoints": [9564], "characters": "\u255C" },
  "&boxUL;": { "codepoints": [9565], "characters": "\u255D" },
  "&boxur;": { "codepoints": [9492], "characters": "\u2514" },
  "&boxuR;": { "codepoints": [9560], "characters": "\u2558" },
  "&boxUr;": { "codepoints": [9561], "characters": "\u2559" },
  "&boxUR;": { "codepoints": [9562], "characters": "\u255A" },
  "&boxv;": { "codepoints": [9474], "characters": "\u2502" },
  "&boxV;": { "codepoints": [9553], "characters": "\u2551" },
  "&boxvh;": { "codepoints": [9532], "characters": "\u253C" },
  "&boxvH;": { "codepoints": [9578], "characters": "\u256A" },
  "&boxVh;": { "codepoints": [9579], "characters": "\u256B" },
  "&boxVH;": { "codepoints": [9580], "characters": "\u256C" },
  "&boxvl;": { "codepoints": [9508], "characters": "\u2524" },
  "&boxvL;": { "codepoints": [9569], "characters": "\u2561" },
  "&boxVl;": { "codepoints": [9570], "characters": "\u2562" },
  "&boxVL;": { "codepoints": [9571], "characters": "\u2563" },
  "&boxvr;": { "codepoints": [9500], "characters": "\u251C" },
  "&boxvR;": { "codepoints": [9566], "characters": "\u255E" },
  "&boxVr;": { "codepoints": [9567], "characters": "\u255F" },
  "&boxVR;": { "codepoints": [9568], "characters": "\u2560" },
  "&bprime;": { "codepoints": [8245], "characters": "\u2035" },
  "&breve;": { "codepoints": [728], "characters": "\u02D8" },
  "&Breve;": { "codepoints": [728], "characters": "\u02D8" },
  "&brvbar;": { "codepoints": [166], "characters": "\u00A6" },
  "&brvbar": { "codepoints": [166], "characters": "\u00A6" },
  "&bscr;": { "codepoints": [119991], "characters": "\uD835\uDCB7" },
  "&Bscr;": { "codepoints": [8492], "characters": "\u212C" },
  "&bsemi;": { "codepoints": [8271], "characters": "\u204F" },
  "&bsim;": { "codepoints": [8765], "characters": "\u223D" },
  "&bsime;": { "codepoints": [8909], "characters": "\u22CD" },
  "&bsolb;": { "codepoints": [10693], "characters": "\u29C5" },
  "&bsol;": { "codepoints": [92], "characters": "\u005C" },
  "&bsolhsub;": { "codepoints": [10184], "characters": "\u27C8" },
  "&bull;": { "codepoints": [8226], "characters": "\u2022" },
  "&bullet;": { "codepoints": [8226], "characters": "\u2022" },
  "&bump;": { "codepoints": [8782], "characters": "\u224E" },
  "&bumpE;": { "codepoints": [10926], "characters": "\u2AAE" },
  "&bumpe;": { "codepoints": [8783], "characters": "\u224F" },
  "&Bumpeq;": { "codepoints": [8782], "characters": "\u224E" },
  "&bumpeq;": { "codepoints": [8783], "characters": "\u224F" },
  "&Cacute;": { "codepoints": [262], "characters": "\u0106" },
  "&cacute;": { "codepoints": [263], "characters": "\u0107" },
  "&capand;": { "codepoints": [10820], "characters": "\u2A44" },
  "&capbrcup;": { "codepoints": [10825], "characters": "\u2A49" },
  "&capcap;": { "codepoints": [10827], "characters": "\u2A4B" },
  "&cap;": { "codepoints": [8745], "characters": "\u2229" },
  "&Cap;": { "codepoints": [8914], "characters": "\u22D2" },
  "&capcup;": { "codepoints": [10823], "characters": "\u2A47" },
  "&capdot;": { "codepoints": [10816], "characters": "\u2A40" },
  "&CapitalDifferentialD;": { "codepoints": [8517], "characters": "\u2145" },
  "&caps;": { "codepoints": [8745, 65024], "characters": "\u2229\uFE00" },
  "&caret;": { "codepoints": [8257], "characters": "\u2041" },
  "&caron;": { "codepoints": [711], "characters": "\u02C7" },
  "&Cayleys;": { "codepoints": [8493], "characters": "\u212D" },
  "&ccaps;": { "codepoints": [10829], "characters": "\u2A4D" },
  "&Ccaron;": { "codepoints": [268], "characters": "\u010C" },
  "&ccaron;": { "codepoints": [269], "characters": "\u010D" },
  "&Ccedil;": { "codepoints": [199], "characters": "\u00C7" },
  "&Ccedil": { "codepoints": [199], "characters": "\u00C7" },
  "&ccedil;": { "codepoints": [231], "characters": "\u00E7" },
  "&ccedil": { "codepoints": [231], "characters": "\u00E7" },
  "&Ccirc;": { "codepoints": [264], "characters": "\u0108" },
  "&ccirc;": { "codepoints": [265], "characters": "\u0109" },
  "&Cconint;": { "codepoints": [8752], "characters": "\u2230" },
  "&ccups;": { "codepoints": [10828], "characters": "\u2A4C" },
  "&ccupssm;": { "codepoints": [10832], "characters": "\u2A50" },
  "&Cdot;": { "codepoints": [266], "characters": "\u010A" },
  "&cdot;": { "codepoints": [267], "characters": "\u010B" },
  "&cedil;": { "codepoints": [184], "characters": "\u00B8" },
  "&cedil": { "codepoints": [184], "characters": "\u00B8" },
  "&Cedilla;": { "codepoints": [184], "characters": "\u00B8" },
  "&cemptyv;": { "codepoints": [10674], "characters": "\u29B2" },
  "&cent;": { "codepoints": [162], "characters": "\u00A2" },
  "&cent": { "codepoints": [162], "characters": "\u00A2" },
  "&centerdot;": { "codepoints": [183], "characters": "\u00B7" },
  "&CenterDot;": { "codepoints": [183], "characters": "\u00B7" },
  "&cfr;": { "codepoints": [120096], "characters": "\uD835\uDD20" },
  "&Cfr;": { "codepoints": [8493], "characters": "\u212D" },
  "&CHcy;": { "codepoints": [1063], "characters": "\u0427" },
  "&chcy;": { "codepoints": [1095], "characters": "\u0447" },
  "&check;": { "codepoints": [10003], "characters": "\u2713" },
  "&checkmark;": { "codepoints": [10003], "characters": "\u2713" },
  "&Chi;": { "codepoints": [935], "characters": "\u03A7" },
  "&chi;": { "codepoints": [967], "characters": "\u03C7" },
  "&circ;": { "codepoints": [710], "characters": "\u02C6" },
  "&circeq;": { "codepoints": [8791], "characters": "\u2257" },
  "&circlearrowleft;": { "codepoints": [8634], "characters": "\u21BA" },
  "&circlearrowright;": { "codepoints": [8635], "characters": "\u21BB" },
  "&circledast;": { "codepoints": [8859], "characters": "\u229B" },
  "&circledcirc;": { "codepoints": [8858], "characters": "\u229A" },
  "&circleddash;": { "codepoints": [8861], "characters": "\u229D" },
  "&CircleDot;": { "codepoints": [8857], "characters": "\u2299" },
  "&circledR;": { "codepoints": [174], "characters": "\u00AE" },
  "&circledS;": { "codepoints": [9416], "characters": "\u24C8" },
  "&CircleMinus;": { "codepoints": [8854], "characters": "\u2296" },
  "&CirclePlus;": { "codepoints": [8853], "characters": "\u2295" },
  "&CircleTimes;": { "codepoints": [8855], "characters": "\u2297" },
  "&cir;": { "codepoints": [9675], "characters": "\u25CB" },
  "&cirE;": { "codepoints": [10691], "characters": "\u29C3" },
  "&cire;": { "codepoints": [8791], "characters": "\u2257" },
  "&cirfnint;": { "codepoints": [10768], "characters": "\u2A10" },
  "&cirmid;": { "codepoints": [10991], "characters": "\u2AEF" },
  "&cirscir;": { "codepoints": [10690], "characters": "\u29C2" },
  "&ClockwiseContourIntegral;": { "codepoints": [8754], "characters": "\u2232" },
  "&CloseCurlyDoubleQuote;": { "codepoints": [8221], "characters": "\u201D" },
  "&CloseCurlyQuote;": { "codepoints": [8217], "characters": "\u2019" },
  "&clubs;": { "codepoints": [9827], "characters": "\u2663" },
  "&clubsuit;": { "codepoints": [9827], "characters": "\u2663" },
  "&colon;": { "codepoints": [58], "characters": "\u003A" },
  "&Colon;": { "codepoints": [8759], "characters": "\u2237" },
  "&Colone;": { "codepoints": [10868], "characters": "\u2A74" },
  "&colone;": { "codepoints": [8788], "characters": "\u2254" },
  "&coloneq;": { "codepoints": [8788], "characters": "\u2254" },
  "&comma;": { "codepoints": [44], "characters": "\u002C" },
  "&commat;": { "codepoints": [64], "characters": "\u0040" },
  "&comp;": { "codepoints": [8705], "characters": "\u2201" },
  "&compfn;": { "codepoints": [8728], "characters": "\u2218" },
  "&complement;": { "codepoints": [8705], "characters": "\u2201" },
  "&complexes;": { "codepoints": [8450], "characters": "\u2102" },
  "&cong;": { "codepoints": [8773], "characters": "\u2245" },
  "&congdot;": { "codepoints": [10861], "characters": "\u2A6D" },
  "&Congruent;": { "codepoints": [8801], "characters": "\u2261" },
  "&conint;": { "codepoints": [8750], "characters": "\u222E" },
  "&Conint;": { "codepoints": [8751], "characters": "\u222F" },
  "&ContourIntegral;": { "codepoints": [8750], "characters": "\u222E" },
  "&copf;": { "codepoints": [120148], "characters": "\uD835\uDD54" },
  "&Copf;": { "codepoints": [8450], "characters": "\u2102" },
  "&coprod;": { "codepoints": [8720], "characters": "\u2210" },
  "&Coproduct;": { "codepoints": [8720], "characters": "\u2210" },
  "&copy;": { "codepoints": [169], "characters": "\u00A9" },
  "&copy": { "codepoints": [169], "characters": "\u00A9" },
  "&COPY;": { "codepoints": [169], "characters": "\u00A9" },
  "&COPY": { "codepoints": [169], "characters": "\u00A9" },
  "&copysr;": { "codepoints": [8471], "characters": "\u2117" },
  "&CounterClockwiseContourIntegral;": { "codepoints": [8755], "characters": "\u2233" },
  "&crarr;": { "codepoints": [8629], "characters": "\u21B5" },
  "&cross;": { "codepoints": [10007], "characters": "\u2717" },
  "&Cross;": { "codepoints": [10799], "characters": "\u2A2F" },
  "&Cscr;": { "codepoints": [119966], "characters": "\uD835\uDC9E" },
  "&cscr;": { "codepoints": [119992], "characters": "\uD835\uDCB8" },
  "&csub;": { "codepoints": [10959], "characters": "\u2ACF" },
  "&csube;": { "codepoints": [10961], "characters": "\u2AD1" },
  "&csup;": { "codepoints": [10960], "characters": "\u2AD0" },
  "&csupe;": { "codepoints": [10962], "characters": "\u2AD2" },
  "&ctdot;": { "codepoints": [8943], "characters": "\u22EF" },
  "&cudarrl;": { "codepoints": [10552], "characters": "\u2938" },
  "&cudarrr;": { "codepoints": [10549], "characters": "\u2935" },
  "&cuepr;": { "codepoints": [8926], "characters": "\u22DE" },
  "&cuesc;": { "codepoints": [8927], "characters": "\u22DF" },
  "&cularr;": { "codepoints": [8630], "characters": "\u21B6" },
  "&cularrp;": { "codepoints": [10557], "characters": "\u293D" },
  "&cupbrcap;": { "codepoints": [10824], "characters": "\u2A48" },
  "&cupcap;": { "codepoints": [10822], "characters": "\u2A46" },
  "&CupCap;": { "codepoints": [8781], "characters": "\u224D" },
  "&cup;": { "codepoints": [8746], "characters": "\u222A" },
  "&Cup;": { "codepoints": [8915], "characters": "\u22D3" },
  "&cupcup;": { "codepoints": [10826], "characters": "\u2A4A" },
  "&cupdot;": { "codepoints": [8845], "characters": "\u228D" },
  "&cupor;": { "codepoints": [10821], "characters": "\u2A45" },
  "&cups;": { "codepoints": [8746, 65024], "characters": "\u222A\uFE00" },
  "&curarr;": { "codepoints": [8631], "characters": "\u21B7" },
  "&curarrm;": { "codepoints": [10556], "characters": "\u293C" },
  "&curlyeqprec;": { "codepoints": [8926], "characters": "\u22DE" },
  "&curlyeqsucc;": { "codepoints": [8927], "characters": "\u22DF" },
  "&curlyvee;": { "codepoints": [8910], "characters": "\u22CE" },
  "&curlywedge;": { "codepoints": [8911], "characters": "\u22CF" },
  "&curren;": { "codepoints": [164], "characters": "\u00A4" },
  "&curren": { "codepoints": [164], "characters": "\u00A4" },
  "&curvearrowleft;": { "codepoints": [8630], "characters": "\u21B6" },
  "&curvearrowright;": { "codepoints": [8631], "characters": "\u21B7" },
  "&cuvee;": { "codepoints": [8910], "characters": "\u22CE" },
  "&cuwed;": { "codepoints": [8911], "characters": "\u22CF" },
  "&cwconint;": { "codepoints": [8754], "characters": "\u2232" },
  "&cwint;": { "codepoints": [8753], "characters": "\u2231" },
  "&cylcty;": { "codepoints": [9005], "characters": "\u232D" },
  "&dagger;": { "codepoints": [8224], "characters": "\u2020" },
  "&Dagger;": { "codepoints": [8225], "characters": "\u2021" },
  "&daleth;": { "codepoints": [8504], "characters": "\u2138" },
  "&darr;": { "codepoints": [8595], "characters": "\u2193" },
  "&Darr;": { "codepoints": [8609], "characters": "\u21A1" },
  "&dArr;": { "codepoints": [8659], "characters": "\u21D3" },
  "&dash;": { "codepoints": [8208], "characters": "\u2010" },
  "&Dashv;": { "codepoints": [10980], "characters": "\u2AE4" },
  "&dashv;": { "codepoints": [8867], "characters": "\u22A3" },
  "&dbkarow;": { "codepoints": [10511], "characters": "\u290F" },
  "&dblac;": { "codepoints": [733], "characters": "\u02DD" },
  "&Dcaron;": { "codepoints": [270], "characters": "\u010E" },
  "&dcaron;": { "codepoints": [271], "characters": "\u010F" },
  "&Dcy;": { "codepoints": [1044], "characters": "\u0414" },
  "&dcy;": { "codepoints": [1076], "characters": "\u0434" },
  "&ddagger;": { "codepoints": [8225], "characters": "\u2021" },
  "&ddarr;": { "codepoints": [8650], "characters": "\u21CA" },
  "&DD;": { "codepoints": [8517], "characters": "\u2145" },
  "&dd;": { "codepoints": [8518], "characters": "\u2146" },
  "&DDotrahd;": { "codepoints": [10513], "characters": "\u2911" },
  "&ddotseq;": { "codepoints": [10871], "characters": "\u2A77" },
  "&deg;": { "codepoints": [176], "characters": "\u00B0" },
  "&deg": { "codepoints": [176], "characters": "\u00B0" },
  "&Del;": { "codepoints": [8711], "characters": "\u2207" },
  "&Delta;": { "codepoints": [916], "characters": "\u0394" },
  "&delta;": { "codepoints": [948], "characters": "\u03B4" },
  "&demptyv;": { "codepoints": [10673], "characters": "\u29B1" },
  "&dfisht;": { "codepoints": [10623], "characters": "\u297F" },
  "&Dfr;": { "codepoints": [120071], "characters": "\uD835\uDD07" },
  "&dfr;": { "codepoints": [120097], "characters": "\uD835\uDD21" },
  "&dHar;": { "codepoints": [10597], "characters": "\u2965" },
  "&dharl;": { "codepoints": [8643], "characters": "\u21C3" },
  "&dharr;": { "codepoints": [8642], "characters": "\u21C2" },
  "&DiacriticalAcute;": { "codepoints": [180], "characters": "\u00B4" },
  "&DiacriticalDot;": { "codepoints": [729], "characters": "\u02D9" },
  "&DiacriticalDoubleAcute;": { "codepoints": [733], "characters": "\u02DD" },
  "&DiacriticalGrave;": { "codepoints": [96], "characters": "\u0060" },
  "&DiacriticalTilde;": { "codepoints": [732], "characters": "\u02DC" },
  "&diam;": { "codepoints": [8900], "characters": "\u22C4" },
  "&diamond;": { "codepoints": [8900], "characters": "\u22C4" },
  "&Diamond;": { "codepoints": [8900], "characters": "\u22C4" },
  "&diamondsuit;": { "codepoints": [9830], "characters": "\u2666" },
  "&diams;": { "codepoints": [9830], "characters": "\u2666" },
  "&die;": { "codepoints": [168], "characters": "\u00A8" },
  "&DifferentialD;": { "codepoints": [8518], "characters": "\u2146" },
  "&digamma;": { "codepoints": [989], "characters": "\u03DD" },
  "&disin;": { "codepoints": [8946], "characters": "\u22F2" },
  "&div;": { "codepoints": [247], "characters": "\u00F7" },
  "&divide;": { "codepoints": [247], "characters": "\u00F7" },
  "&divide": { "codepoints": [247], "characters": "\u00F7" },
  "&divideontimes;": { "codepoints": [8903], "characters": "\u22C7" },
  "&divonx;": { "codepoints": [8903], "characters": "\u22C7" },
  "&DJcy;": { "codepoints": [1026], "characters": "\u0402" },
  "&djcy;": { "codepoints": [1106], "characters": "\u0452" },
  "&dlcorn;": { "codepoints": [8990], "characters": "\u231E" },
  "&dlcrop;": { "codepoints": [8973], "characters": "\u230D" },
  "&dollar;": { "codepoints": [36], "characters": "\u0024" },
  "&Dopf;": { "codepoints": [120123], "characters": "\uD835\uDD3B" },
  "&dopf;": { "codepoints": [120149], "characters": "\uD835\uDD55" },
  "&Dot;": { "codepoints": [168], "characters": "\u00A8" },
  "&dot;": { "codepoints": [729], "characters": "\u02D9" },
  "&DotDot;": { "codepoints": [8412], "characters": "\u20DC" },
  "&doteq;": { "codepoints": [8784], "characters": "\u2250" },
  "&doteqdot;": { "codepoints": [8785], "characters": "\u2251" },
  "&DotEqual;": { "codepoints": [8784], "characters": "\u2250" },
  "&dotminus;": { "codepoints": [8760], "characters": "\u2238" },
  "&dotplus;": { "codepoints": [8724], "characters": "\u2214" },
  "&dotsquare;": { "codepoints": [8865], "characters": "\u22A1" },
  "&doublebarwedge;": { "codepoints": [8966], "characters": "\u2306" },
  "&DoubleContourIntegral;": { "codepoints": [8751], "characters": "\u222F" },
  "&DoubleDot;": { "codepoints": [168], "characters": "\u00A8" },
  "&DoubleDownArrow;": { "codepoints": [8659], "characters": "\u21D3" },
  "&DoubleLeftArrow;": { "codepoints": [8656], "characters": "\u21D0" },
  "&DoubleLeftRightArrow;": { "codepoints": [8660], "characters": "\u21D4" },
  "&DoubleLeftTee;": { "codepoints": [10980], "characters": "\u2AE4" },
  "&DoubleLongLeftArrow;": { "codepoints": [10232], "characters": "\u27F8" },
  "&DoubleLongLeftRightArrow;": { "codepoints": [10234], "characters": "\u27FA" },
  "&DoubleLongRightArrow;": { "codepoints": [10233], "characters": "\u27F9" },
  "&DoubleRightArrow;": { "codepoints": [8658], "characters": "\u21D2" },
  "&DoubleRightTee;": { "codepoints": [8872], "characters": "\u22A8" },
  "&DoubleUpArrow;": { "codepoints": [8657], "characters": "\u21D1" },
  "&DoubleUpDownArrow;": { "codepoints": [8661], "characters": "\u21D5" },
  "&DoubleVerticalBar;": { "codepoints": [8741], "characters": "\u2225" },
  "&DownArrowBar;": { "codepoints": [10515], "characters": "\u2913" },
  "&downarrow;": { "codepoints": [8595], "characters": "\u2193" },
  "&DownArrow;": { "codepoints": [8595], "characters": "\u2193" },
  "&Downarrow;": { "codepoints": [8659], "characters": "\u21D3" },
  "&DownArrowUpArrow;": { "codepoints": [8693], "characters": "\u21F5" },
  "&DownBreve;": { "codepoints": [785], "characters": "\u0311" },
  "&downdownarrows;": { "codepoints": [8650], "characters": "\u21CA" },
  "&downharpoonleft;": { "codepoints": [8643], "characters": "\u21C3" },
  "&downharpoonright;": { "codepoints": [8642], "characters": "\u21C2" },
  "&DownLeftRightVector;": { "codepoints": [10576], "characters": "\u2950" },
  "&DownLeftTeeVector;": { "codepoints": [10590], "characters": "\u295E" },
  "&DownLeftVectorBar;": { "codepoints": [10582], "characters": "\u2956" },
  "&DownLeftVector;": { "codepoints": [8637], "characters": "\u21BD" },
  "&DownRightTeeVector;": { "codepoints": [10591], "characters": "\u295F" },
  "&DownRightVectorBar;": { "codepoints": [10583], "characters": "\u2957" },
  "&DownRightVector;": { "codepoints": [8641], "characters": "\u21C1" },
  "&DownTeeArrow;": { "codepoints": [8615], "characters": "\u21A7" },
  "&DownTee;": { "codepoints": [8868], "characters": "\u22A4" },
  "&drbkarow;": { "codepoints": [10512], "characters": "\u2910" },
  "&drcorn;": { "codepoints": [8991], "characters": "\u231F" },
  "&drcrop;": { "codepoints": [8972], "characters": "\u230C" },
  "&Dscr;": { "codepoints": [119967], "characters": "\uD835\uDC9F" },
  "&dscr;": { "codepoints": [119993], "characters": "\uD835\uDCB9" },
  "&DScy;": { "codepoints": [1029], "characters": "\u0405" },
  "&dscy;": { "codepoints": [1109], "characters": "\u0455" },
  "&dsol;": { "codepoints": [10742], "characters": "\u29F6" },
  "&Dstrok;": { "codepoints": [272], "characters": "\u0110" },
  "&dstrok;": { "codepoints": [273], "characters": "\u0111" },
  "&dtdot;": { "codepoints": [8945], "characters": "\u22F1" },
  "&dtri;": { "codepoints": [9663], "characters": "\u25BF" },
  "&dtrif;": { "codepoints": [9662], "characters": "\u25BE" },
  "&duarr;": { "codepoints": [8693], "characters": "\u21F5" },
  "&duhar;": { "codepoints": [10607], "characters": "\u296F" },
  "&dwangle;": { "codepoints": [10662], "characters": "\u29A6" },
  "&DZcy;": { "codepoints": [1039], "characters": "\u040F" },
  "&dzcy;": { "codepoints": [1119], "characters": "\u045F" },
  "&dzigrarr;": { "codepoints": [10239], "characters": "\u27FF" },
  "&Eacute;": { "codepoints": [201], "characters": "\u00C9" },
  "&Eacute": { "codepoints": [201], "characters": "\u00C9" },
  "&eacute;": { "codepoints": [233], "characters": "\u00E9" },
  "&eacute": { "codepoints": [233], "characters": "\u00E9" },
  "&easter;": { "codepoints": [10862], "characters": "\u2A6E" },
  "&Ecaron;": { "codepoints": [282], "characters": "\u011A" },
  "&ecaron;": { "codepoints": [283], "characters": "\u011B" },
  "&Ecirc;": { "codepoints": [202], "characters": "\u00CA" },
  "&Ecirc": { "codepoints": [202], "characters": "\u00CA" },
  "&ecirc;": { "codepoints": [234], "characters": "\u00EA" },
  "&ecirc": { "codepoints": [234], "characters": "\u00EA" },
  "&ecir;": { "codepoints": [8790], "characters": "\u2256" },
  "&ecolon;": { "codepoints": [8789], "characters": "\u2255" },
  "&Ecy;": { "codepoints": [1069], "characters": "\u042D" },
  "&ecy;": { "codepoints": [1101], "characters": "\u044D" },
  "&eDDot;": { "codepoints": [10871], "characters": "\u2A77" },
  "&Edot;": { "codepoints": [278], "characters": "\u0116" },
  "&edot;": { "codepoints": [279], "characters": "\u0117" },
  "&eDot;": { "codepoints": [8785], "characters": "\u2251" },
  "&ee;": { "codepoints": [8519], "characters": "\u2147" },
  "&efDot;": { "codepoints": [8786], "characters": "\u2252" },
  "&Efr;": { "codepoints": [120072], "characters": "\uD835\uDD08" },
  "&efr;": { "codepoints": [120098], "characters": "\uD835\uDD22" },
  "&eg;": { "codepoints": [10906], "characters": "\u2A9A" },
  "&Egrave;": { "codepoints": [200], "characters": "\u00C8" },
  "&Egrave": { "codepoints": [200], "characters": "\u00C8" },
  "&egrave;": { "codepoints": [232], "characters": "\u00E8" },
  "&egrave": { "codepoints": [232], "characters": "\u00E8" },
  "&egs;": { "codepoints": [10902], "characters": "\u2A96" },
  "&egsdot;": { "codepoints": [10904], "characters": "\u2A98" },
  "&el;": { "codepoints": [10905], "characters": "\u2A99" },
  "&Element;": { "codepoints": [8712], "characters": "\u2208" },
  "&elinters;": { "codepoints": [9191], "characters": "\u23E7" },
  "&ell;": { "codepoints": [8467], "characters": "\u2113" },
  "&els;": { "codepoints": [10901], "characters": "\u2A95" },
  "&elsdot;": { "codepoints": [10903], "characters": "\u2A97" },
  "&Emacr;": { "codepoints": [274], "characters": "\u0112" },
  "&emacr;": { "codepoints": [275], "characters": "\u0113" },
  "&empty;": { "codepoints": [8709], "characters": "\u2205" },
  "&emptyset;": { "codepoints": [8709], "characters": "\u2205" },
  "&EmptySmallSquare;": { "codepoints": [9723], "characters": "\u25FB" },
  "&emptyv;": { "codepoints": [8709], "characters": "\u2205" },
  "&EmptyVerySmallSquare;": { "codepoints": [9643], "characters": "\u25AB" },
  "&emsp13;": { "codepoints": [8196], "characters": "\u2004" },
  "&emsp14;": { "codepoints": [8197], "characters": "\u2005" },
  "&emsp;": { "codepoints": [8195], "characters": "\u2003" },
  "&ENG;": { "codepoints": [330], "characters": "\u014A" },
  "&eng;": { "codepoints": [331], "characters": "\u014B" },
  "&ensp;": { "codepoints": [8194], "characters": "\u2002" },
  "&Eogon;": { "codepoints": [280], "characters": "\u0118" },
  "&eogon;": { "codepoints": [281], "characters": "\u0119" },
  "&Eopf;": { "codepoints": [120124], "characters": "\uD835\uDD3C" },
  "&eopf;": { "codepoints": [120150], "characters": "\uD835\uDD56" },
  "&epar;": { "codepoints": [8917], "characters": "\u22D5" },
  "&eparsl;": { "codepoints": [10723], "characters": "\u29E3" },
  "&eplus;": { "codepoints": [10865], "characters": "\u2A71" },
  "&epsi;": { "codepoints": [949], "characters": "\u03B5" },
  "&Epsilon;": { "codepoints": [917], "characters": "\u0395" },
  "&epsilon;": { "codepoints": [949], "characters": "\u03B5" },
  "&epsiv;": { "codepoints": [1013], "characters": "\u03F5" },
  "&eqcirc;": { "codepoints": [8790], "characters": "\u2256" },
  "&eqcolon;": { "codepoints": [8789], "characters": "\u2255" },
  "&eqsim;": { "codepoints": [8770], "characters": "\u2242" },
  "&eqslantgtr;": { "codepoints": [10902], "characters": "\u2A96" },
  "&eqslantless;": { "codepoints": [10901], "characters": "\u2A95" },
  "&Equal;": { "codepoints": [10869], "characters": "\u2A75" },
  "&equals;": { "codepoints": [61], "characters": "\u003D" },
  "&EqualTilde;": { "codepoints": [8770], "characters": "\u2242" },
  "&equest;": { "codepoints": [8799], "characters": "\u225F" },
  "&Equilibrium;": { "codepoints": [8652], "characters": "\u21CC" },
  "&equiv;": { "codepoints": [8801], "characters": "\u2261" },
  "&equivDD;": { "codepoints": [10872], "characters": "\u2A78" },
  "&eqvparsl;": { "codepoints": [10725], "characters": "\u29E5" },
  "&erarr;": { "codepoints": [10609], "characters": "\u2971" },
  "&erDot;": { "codepoints": [8787], "characters": "\u2253" },
  "&escr;": { "codepoints": [8495], "characters": "\u212F" },
  "&Escr;": { "codepoints": [8496], "characters": "\u2130" },
  "&esdot;": { "codepoints": [8784], "characters": "\u2250" },
  "&Esim;": { "codepoints": [10867], "characters": "\u2A73" },
  "&esim;": { "codepoints": [8770], "characters": "\u2242" },
  "&Eta;": { "codepoints": [919], "characters": "\u0397" },
  "&eta;": { "codepoints": [951], "characters": "\u03B7" },
  "&ETH;": { "codepoints": [208], "characters": "\u00D0" },
  "&ETH": { "codepoints": [208], "characters": "\u00D0" },
  "&eth;": { "codepoints": [240], "characters": "\u00F0" },
  "&eth": { "codepoints": [240], "characters": "\u00F0" },
  "&Euml;": { "codepoints": [203], "characters": "\u00CB" },
  "&Euml": { "codepoints": [203], "characters": "\u00CB" },
  "&euml;": { "codepoints": [235], "characters": "\u00EB" },
  "&euml": { "codepoints": [235], "characters": "\u00EB" },
  "&euro;": { "codepoints": [8364], "characters": "\u20AC" },
  "&excl;": { "codepoints": [33], "characters": "\u0021" },
  "&exist;": { "codepoints": [8707], "characters": "\u2203" },
  "&Exists;": { "codepoints": [8707], "characters": "\u2203" },
  "&expectation;": { "codepoints": [8496], "characters": "\u2130" },
  "&exponentiale;": { "codepoints": [8519], "characters": "\u2147" },
  "&ExponentialE;": { "codepoints": [8519], "characters": "\u2147" },
  "&fallingdotseq;": { "codepoints": [8786], "characters": "\u2252" },
  "&Fcy;": { "codepoints": [1060], "characters": "\u0424" },
  "&fcy;": { "codepoints": [1092], "characters": "\u0444" },
  "&female;": { "codepoints": [9792], "characters": "\u2640" },
  "&ffilig;": { "codepoints": [64259], "characters": "\uFB03" },
  "&fflig;": { "codepoints": [64256], "characters": "\uFB00" },
  "&ffllig;": { "codepoints": [64260], "characters": "\uFB04" },
  "&Ffr;": { "codepoints": [120073], "characters": "\uD835\uDD09" },
  "&ffr;": { "codepoints": [120099], "characters": "\uD835\uDD23" },
  "&filig;": { "codepoints": [64257], "characters": "\uFB01" },
  "&FilledSmallSquare;": { "codepoints": [9724], "characters": "\u25FC" },
  "&FilledVerySmallSquare;": { "codepoints": [9642], "characters": "\u25AA" },
  "&fjlig;": { "codepoints": [102, 106], "characters": "\u0066\u006A" },
  "&flat;": { "codepoints": [9837], "characters": "\u266D" },
  "&fllig;": { "codepoints": [64258], "characters": "\uFB02" },
  "&fltns;": { "codepoints": [9649], "characters": "\u25B1" },
  "&fnof;": { "codepoints": [402], "characters": "\u0192" },
  "&Fopf;": { "codepoints": [120125], "characters": "\uD835\uDD3D" },
  "&fopf;": { "codepoints": [120151], "characters": "\uD835\uDD57" },
  "&forall;": { "codepoints": [8704], "characters": "\u2200" },
  "&ForAll;": { "codepoints": [8704], "characters": "\u2200" },
  "&fork;": { "codepoints": [8916], "characters": "\u22D4" },
  "&forkv;": { "codepoints": [10969], "characters": "\u2AD9" },
  "&Fouriertrf;": { "codepoints": [8497], "characters": "\u2131" },
  "&fpartint;": { "codepoints": [10765], "characters": "\u2A0D" },
  "&frac12;": { "codepoints": [189], "characters": "\u00BD" },
  "&frac12": { "codepoints": [189], "characters": "\u00BD" },
  "&frac13;": { "codepoints": [8531], "characters": "\u2153" },
  "&frac14;": { "codepoints": [188], "characters": "\u00BC" },
  "&frac14": { "codepoints": [188], "characters": "\u00BC" },
  "&frac15;": { "codepoints": [8533], "characters": "\u2155" },
  "&frac16;": { "codepoints": [8537], "characters": "\u2159" },
  "&frac18;": { "codepoints": [8539], "characters": "\u215B" },
  "&frac23;": { "codepoints": [8532], "characters": "\u2154" },
  "&frac25;": { "codepoints": [8534], "characters": "\u2156" },
  "&frac34;": { "codepoints": [190], "characters": "\u00BE" },
  "&frac34": { "codepoints": [190], "characters": "\u00BE" },
  "&frac35;": { "codepoints": [8535], "characters": "\u2157" },
  "&frac38;": { "codepoints": [8540], "characters": "\u215C" },
  "&frac45;": { "codepoints": [8536], "characters": "\u2158" },
  "&frac56;": { "codepoints": [8538], "characters": "\u215A" },
  "&frac58;": { "codepoints": [8541], "characters": "\u215D" },
  "&frac78;": { "codepoints": [8542], "characters": "\u215E" },
  "&frasl;": { "codepoints": [8260], "characters": "\u2044" },
  "&frown;": { "codepoints": [8994], "characters": "\u2322" },
  "&fscr;": { "codepoints": [119995], "characters": "\uD835\uDCBB" },
  "&Fscr;": { "codepoints": [8497], "characters": "\u2131" },
  "&gacute;": { "codepoints": [501], "characters": "\u01F5" },
  "&Gamma;": { "codepoints": [915], "characters": "\u0393" },
  "&gamma;": { "codepoints": [947], "characters": "\u03B3" },
  "&Gammad;": { "codepoints": [988], "characters": "\u03DC" },
  "&gammad;": { "codepoints": [989], "characters": "\u03DD" },
  "&gap;": { "codepoints": [10886], "characters": "\u2A86" },
  "&Gbreve;": { "codepoints": [286], "characters": "\u011E" },
  "&gbreve;": { "codepoints": [287], "characters": "\u011F" },
  "&Gcedil;": { "codepoints": [290], "characters": "\u0122" },
  "&Gcirc;": { "codepoints": [284], "characters": "\u011C" },
  "&gcirc;": { "codepoints": [285], "characters": "\u011D" },
  "&Gcy;": { "codepoints": [1043], "characters": "\u0413" },
  "&gcy;": { "codepoints": [1075], "characters": "\u0433" },
  "&Gdot;": { "codepoints": [288], "characters": "\u0120" },
  "&gdot;": { "codepoints": [289], "characters": "\u0121" },
  "&ge;": { "codepoints": [8805], "characters": "\u2265" },
  "&gE;": { "codepoints": [8807], "characters": "\u2267" },
  "&gEl;": { "codepoints": [10892], "characters": "\u2A8C" },
  "&gel;": { "codepoints": [8923], "characters": "\u22DB" },
  "&geq;": { "codepoints": [8805], "characters": "\u2265" },
  "&geqq;": { "codepoints": [8807], "characters": "\u2267" },
  "&geqslant;": { "codepoints": [10878], "characters": "\u2A7E" },
  "&gescc;": { "codepoints": [10921], "characters": "\u2AA9" },
  "&ges;": { "codepoints": [10878], "characters": "\u2A7E" },
  "&gesdot;": { "codepoints": [10880], "characters": "\u2A80" },
  "&gesdoto;": { "codepoints": [10882], "characters": "\u2A82" },
  "&gesdotol;": { "codepoints": [10884], "characters": "\u2A84" },
  "&gesl;": { "codepoints": [8923, 65024], "characters": "\u22DB\uFE00" },
  "&gesles;": { "codepoints": [10900], "characters": "\u2A94" },
  "&Gfr;": { "codepoints": [120074], "characters": "\uD835\uDD0A" },
  "&gfr;": { "codepoints": [120100], "characters": "\uD835\uDD24" },
  "&gg;": { "codepoints": [8811], "characters": "\u226B" },
  "&Gg;": { "codepoints": [8921], "characters": "\u22D9" },
  "&ggg;": { "codepoints": [8921], "characters": "\u22D9" },
  "&gimel;": { "codepoints": [8503], "characters": "\u2137" },
  "&GJcy;": { "codepoints": [1027], "characters": "\u0403" },
  "&gjcy;": { "codepoints": [1107], "characters": "\u0453" },
  "&gla;": { "codepoints": [10917], "characters": "\u2AA5" },
  "&gl;": { "codepoints": [8823], "characters": "\u2277" },
  "&glE;": { "codepoints": [10898], "characters": "\u2A92" },
  "&glj;": { "codepoints": [10916], "characters": "\u2AA4" },
  "&gnap;": { "codepoints": [10890], "characters": "\u2A8A" },
  "&gnapprox;": { "codepoints": [10890], "characters": "\u2A8A" },
  "&gne;": { "codepoints": [10888], "characters": "\u2A88" },
  "&gnE;": { "codepoints": [8809], "characters": "\u2269" },
  "&gneq;": { "codepoints": [10888], "characters": "\u2A88" },
  "&gneqq;": { "codepoints": [8809], "characters": "\u2269" },
  "&gnsim;": { "codepoints": [8935], "characters": "\u22E7" },
  "&Gopf;": { "codepoints": [120126], "characters": "\uD835\uDD3E" },
  "&gopf;": { "codepoints": [120152], "characters": "\uD835\uDD58" },
  "&grave;": { "codepoints": [96], "characters": "\u0060" },
  "&GreaterEqual;": { "codepoints": [8805], "characters": "\u2265" },
  "&GreaterEqualLess;": { "codepoints": [8923], "characters": "\u22DB" },
  "&GreaterFullEqual;": { "codepoints": [8807], "characters": "\u2267" },
  "&GreaterGreater;": { "codepoints": [10914], "characters": "\u2AA2" },
  "&GreaterLess;": { "codepoints": [8823], "characters": "\u2277" },
  "&GreaterSlantEqual;": { "codepoints": [10878], "characters": "\u2A7E" },
  "&GreaterTilde;": { "codepoints": [8819], "characters": "\u2273" },
  "&Gscr;": { "codepoints": [119970], "characters": "\uD835\uDCA2" },
  "&gscr;": { "codepoints": [8458], "characters": "\u210A" },
  "&gsim;": { "codepoints": [8819], "characters": "\u2273" },
  "&gsime;": { "codepoints": [10894], "characters": "\u2A8E" },
  "&gsiml;": { "codepoints": [10896], "characters": "\u2A90" },
  "&gtcc;": { "codepoints": [10919], "characters": "\u2AA7" },
  "&gtcir;": { "codepoints": [10874], "characters": "\u2A7A" },
  "&gt;": { "codepoints": [62], "characters": "\u003E" },
  "&gt": { "codepoints": [62], "characters": "\u003E" },
  "&GT;": { "codepoints": [62], "characters": "\u003E" },
  "&GT": { "codepoints": [62], "characters": "\u003E" },
  "&Gt;": { "codepoints": [8811], "characters": "\u226B" },
  "&gtdot;": { "codepoints": [8919], "characters": "\u22D7" },
  "&gtlPar;": { "codepoints": [10645], "characters": "\u2995" },
  "&gtquest;": { "codepoints": [10876], "characters": "\u2A7C" },
  "&gtrapprox;": { "codepoints": [10886], "characters": "\u2A86" },
  "&gtrarr;": { "codepoints": [10616], "characters": "\u2978" },
  "&gtrdot;": { "codepoints": [8919], "characters": "\u22D7" },
  "&gtreqless;": { "codepoints": [8923], "characters": "\u22DB" },
  "&gtreqqless;": { "codepoints": [10892], "characters": "\u2A8C" },
  "&gtrless;": { "codepoints": [8823], "characters": "\u2277" },
  "&gtrsim;": { "codepoints": [8819], "characters": "\u2273" },
  "&gvertneqq;": { "codepoints": [8809, 65024], "characters": "\u2269\uFE00" },
  "&gvnE;": { "codepoints": [8809, 65024], "characters": "\u2269\uFE00" },
  "&Hacek;": { "codepoints": [711], "characters": "\u02C7" },
  "&hairsp;": { "codepoints": [8202], "characters": "\u200A" },
  "&half;": { "codepoints": [189], "characters": "\u00BD" },
  "&hamilt;": { "codepoints": [8459], "characters": "\u210B" },
  "&HARDcy;": { "codepoints": [1066], "characters": "\u042A" },
  "&hardcy;": { "codepoints": [1098], "characters": "\u044A" },
  "&harrcir;": { "codepoints": [10568], "characters": "\u2948" },
  "&harr;": { "codepoints": [8596], "characters": "\u2194" },
  "&hArr;": { "codepoints": [8660], "characters": "\u21D4" },
  "&harrw;": { "codepoints": [8621], "characters": "\u21AD" },
  "&Hat;": { "codepoints": [94], "characters": "\u005E" },
  "&hbar;": { "codepoints": [8463], "characters": "\u210F" },
  "&Hcirc;": { "codepoints": [292], "characters": "\u0124" },
  "&hcirc;": { "codepoints": [293], "characters": "\u0125" },
  "&hearts;": { "codepoints": [9829], "characters": "\u2665" },
  "&heartsuit;": { "codepoints": [9829], "characters": "\u2665" },
  "&hellip;": { "codepoints": [8230], "characters": "\u2026" },
  "&hercon;": { "codepoints": [8889], "characters": "\u22B9" },
  "&hfr;": { "codepoints": [120101], "characters": "\uD835\uDD25" },
  "&Hfr;": { "codepoints": [8460], "characters": "\u210C" },
  "&HilbertSpace;": { "codepoints": [8459], "characters": "\u210B" },
  "&hksearow;": { "codepoints": [10533], "characters": "\u2925" },
  "&hkswarow;": { "codepoints": [10534], "characters": "\u2926" },
  "&hoarr;": { "codepoints": [8703], "characters": "\u21FF" },
  "&homtht;": { "codepoints": [8763], "characters": "\u223B" },
  "&hookleftarrow;": { "codepoints": [8617], "characters": "\u21A9" },
  "&hookrightarrow;": { "codepoints": [8618], "characters": "\u21AA" },
  "&hopf;": { "codepoints": [120153], "characters": "\uD835\uDD59" },
  "&Hopf;": { "codepoints": [8461], "characters": "\u210D" },
  "&horbar;": { "codepoints": [8213], "characters": "\u2015" },
  "&HorizontalLine;": { "codepoints": [9472], "characters": "\u2500" },
  "&hscr;": { "codepoints": [119997], "characters": "\uD835\uDCBD" },
  "&Hscr;": { "codepoints": [8459], "characters": "\u210B" },
  "&hslash;": { "codepoints": [8463], "characters": "\u210F" },
  "&Hstrok;": { "codepoints": [294], "characters": "\u0126" },
  "&hstrok;": { "codepoints": [295], "characters": "\u0127" },
  "&HumpDownHump;": { "codepoints": [8782], "characters": "\u224E" },
  "&HumpEqual;": { "codepoints": [8783], "characters": "\u224F" },
  "&hybull;": { "codepoints": [8259], "characters": "\u2043" },
  "&hyphen;": { "codepoints": [8208], "characters": "\u2010" },
  "&Iacute;": { "codepoints": [205], "characters": "\u00CD" },
  "&Iacute": { "codepoints": [205], "characters": "\u00CD" },
  "&iacute;": { "codepoints": [237], "characters": "\u00ED" },
  "&iacute": { "codepoints": [237], "characters": "\u00ED" },
  "&ic;": { "codepoints": [8291], "characters": "\u2063" },
  "&Icirc;": { "codepoints": [206], "characters": "\u00CE" },
  "&Icirc": { "codepoints": [206], "characters": "\u00CE" },
  "&icirc;": { "codepoints": [238], "characters": "\u00EE" },
  "&icirc": { "codepoints": [238], "characters": "\u00EE" },
  "&Icy;": { "codepoints": [1048], "characters": "\u0418" },
  "&icy;": { "codepoints": [1080], "characters": "\u0438" },
  "&Idot;": { "codepoints": [304], "characters": "\u0130" },
  "&IEcy;": { "codepoints": [1045], "characters": "\u0415" },
  "&iecy;": { "codepoints": [1077], "characters": "\u0435" },
  "&iexcl;": { "codepoints": [161], "characters": "\u00A1" },
  "&iexcl": { "codepoints": [161], "characters": "\u00A1" },
  "&iff;": { "codepoints": [8660], "characters": "\u21D4" },
  "&ifr;": { "codepoints": [120102], "characters": "\uD835\uDD26" },
  "&Ifr;": { "codepoints": [8465], "characters": "\u2111" },
  "&Igrave;": { "codepoints": [204], "characters": "\u00CC" },
  "&Igrave": { "codepoints": [204], "characters": "\u00CC" },
  "&igrave;": { "codepoints": [236], "characters": "\u00EC" },
  "&igrave": { "codepoints": [236], "characters": "\u00EC" },
  "&ii;": { "codepoints": [8520], "characters": "\u2148" },
  "&iiiint;": { "codepoints": [10764], "characters": "\u2A0C" },
  "&iiint;": { "codepoints": [8749], "characters": "\u222D" },
  "&iinfin;": { "codepoints": [10716], "characters": "\u29DC" },
  "&iiota;": { "codepoints": [8489], "characters": "\u2129" },
  "&IJlig;": { "codepoints": [306], "characters": "\u0132" },
  "&ijlig;": { "codepoints": [307], "characters": "\u0133" },
  "&Imacr;": { "codepoints": [298], "characters": "\u012A" },
  "&imacr;": { "codepoints": [299], "characters": "\u012B" },
  "&image;": { "codepoints": [8465], "characters": "\u2111" },
  "&ImaginaryI;": { "codepoints": [8520], "characters": "\u2148" },
  "&imagline;": { "codepoints": [8464], "characters": "\u2110" },
  "&imagpart;": { "codepoints": [8465], "characters": "\u2111" },
  "&imath;": { "codepoints": [305], "characters": "\u0131" },
  "&Im;": { "codepoints": [8465], "characters": "\u2111" },
  "&imof;": { "codepoints": [8887], "characters": "\u22B7" },
  "&imped;": { "codepoints": [437], "characters": "\u01B5" },
  "&Implies;": { "codepoints": [8658], "characters": "\u21D2" },
  "&incare;": { "codepoints": [8453], "characters": "\u2105" },
  "&in;": { "codepoints": [8712], "characters": "\u2208" },
  "&infin;": { "codepoints": [8734], "characters": "\u221E" },
  "&infintie;": { "codepoints": [10717], "characters": "\u29DD" },
  "&inodot;": { "codepoints": [305], "characters": "\u0131" },
  "&intcal;": { "codepoints": [8890], "characters": "\u22BA" },
  "&int;": { "codepoints": [8747], "characters": "\u222B" },
  "&Int;": { "codepoints": [8748], "characters": "\u222C" },
  "&integers;": { "codepoints": [8484], "characters": "\u2124" },
  "&Integral;": { "codepoints": [8747], "characters": "\u222B" },
  "&intercal;": { "codepoints": [8890], "characters": "\u22BA" },
  "&Intersection;": { "codepoints": [8898], "characters": "\u22C2" },
  "&intlarhk;": { "codepoints": [10775], "characters": "\u2A17" },
  "&intprod;": { "codepoints": [10812], "characters": "\u2A3C" },
  "&InvisibleComma;": { "codepoints": [8291], "characters": "\u2063" },
  "&InvisibleTimes;": { "codepoints": [8290], "characters": "\u2062" },
  "&IOcy;": { "codepoints": [1025], "characters": "\u0401" },
  "&iocy;": { "codepoints": [1105], "characters": "\u0451" },
  "&Iogon;": { "codepoints": [302], "characters": "\u012E" },
  "&iogon;": { "codepoints": [303], "characters": "\u012F" },
  "&Iopf;": { "codepoints": [120128], "characters": "\uD835\uDD40" },
  "&iopf;": { "codepoints": [120154], "characters": "\uD835\uDD5A" },
  "&Iota;": { "codepoints": [921], "characters": "\u0399" },
  "&iota;": { "codepoints": [953], "characters": "\u03B9" },
  "&iprod;": { "codepoints": [10812], "characters": "\u2A3C" },
  "&iquest;": { "codepoints": [191], "characters": "\u00BF" },
  "&iquest": { "codepoints": [191], "characters": "\u00BF" },
  "&iscr;": { "codepoints": [119998], "characters": "\uD835\uDCBE" },
  "&Iscr;": { "codepoints": [8464], "characters": "\u2110" },
  "&isin;": { "codepoints": [8712], "characters": "\u2208" },
  "&isindot;": { "codepoints": [8949], "characters": "\u22F5" },
  "&isinE;": { "codepoints": [8953], "characters": "\u22F9" },
  "&isins;": { "codepoints": [8948], "characters": "\u22F4" },
  "&isinsv;": { "codepoints": [8947], "characters": "\u22F3" },
  "&isinv;": { "codepoints": [8712], "characters": "\u2208" },
  "&it;": { "codepoints": [8290], "characters": "\u2062" },
  "&Itilde;": { "codepoints": [296], "characters": "\u0128" },
  "&itilde;": { "codepoints": [297], "characters": "\u0129" },
  "&Iukcy;": { "codepoints": [1030], "characters": "\u0406" },
  "&iukcy;": { "codepoints": [1110], "characters": "\u0456" },
  "&Iuml;": { "codepoints": [207], "characters": "\u00CF" },
  "&Iuml": { "codepoints": [207], "characters": "\u00CF" },
  "&iuml;": { "codepoints": [239], "characters": "\u00EF" },
  "&iuml": { "codepoints": [239], "characters": "\u00EF" },
  "&Jcirc;": { "codepoints": [308], "characters": "\u0134" },
  "&jcirc;": { "codepoints": [309], "characters": "\u0135" },
  "&Jcy;": { "codepoints": [1049], "characters": "\u0419" },
  "&jcy;": { "codepoints": [1081], "characters": "\u0439" },
  "&Jfr;": { "codepoints": [120077], "characters": "\uD835\uDD0D" },
  "&jfr;": { "codepoints": [120103], "characters": "\uD835\uDD27" },
  "&jmath;": { "codepoints": [567], "characters": "\u0237" },
  "&Jopf;": { "codepoints": [120129], "characters": "\uD835\uDD41" },
  "&jopf;": { "codepoints": [120155], "characters": "\uD835\uDD5B" },
  "&Jscr;": { "codepoints": [119973], "characters": "\uD835\uDCA5" },
  "&jscr;": { "codepoints": [119999], "characters": "\uD835\uDCBF" },
  "&Jsercy;": { "codepoints": [1032], "characters": "\u0408" },
  "&jsercy;": { "codepoints": [1112], "characters": "\u0458" },
  "&Jukcy;": { "codepoints": [1028], "characters": "\u0404" },
  "&jukcy;": { "codepoints": [1108], "characters": "\u0454" },
  "&Kappa;": { "codepoints": [922], "characters": "\u039A" },
  "&kappa;": { "codepoints": [954], "characters": "\u03BA" },
  "&kappav;": { "codepoints": [1008], "characters": "\u03F0" },
  "&Kcedil;": { "codepoints": [310], "characters": "\u0136" },
  "&kcedil;": { "codepoints": [311], "characters": "\u0137" },
  "&Kcy;": { "codepoints": [1050], "characters": "\u041A" },
  "&kcy;": { "codepoints": [1082], "characters": "\u043A" },
  "&Kfr;": { "codepoints": [120078], "characters": "\uD835\uDD0E" },
  "&kfr;": { "codepoints": [120104], "characters": "\uD835\uDD28" },
  "&kgreen;": { "codepoints": [312], "characters": "\u0138" },
  "&KHcy;": { "codepoints": [1061], "characters": "\u0425" },
  "&khcy;": { "codepoints": [1093], "characters": "\u0445" },
  "&KJcy;": { "codepoints": [1036], "characters": "\u040C" },
  "&kjcy;": { "codepoints": [1116], "characters": "\u045C" },
  "&Kopf;": { "codepoints": [120130], "characters": "\uD835\uDD42" },
  "&kopf;": { "codepoints": [120156], "characters": "\uD835\uDD5C" },
  "&Kscr;": { "codepoints": [119974], "characters": "\uD835\uDCA6" },
  "&kscr;": { "codepoints": [120000], "characters": "\uD835\uDCC0" },
  "&lAarr;": { "codepoints": [8666], "characters": "\u21DA" },
  "&Lacute;": { "codepoints": [313], "characters": "\u0139" },
  "&lacute;": { "codepoints": [314], "characters": "\u013A" },
  "&laemptyv;": { "codepoints": [10676], "characters": "\u29B4" },
  "&lagran;": { "codepoints": [8466], "characters": "\u2112" },
  "&Lambda;": { "codepoints": [923], "characters": "\u039B" },
  "&lambda;": { "codepoints": [955], "characters": "\u03BB" },
  "&lang;": { "codepoints": [10216], "characters": "\u27E8" },
  "&Lang;": { "codepoints": [10218], "characters": "\u27EA" },
  "&langd;": { "codepoints": [10641], "characters": "\u2991" },
  "&langle;": { "codepoints": [10216], "characters": "\u27E8" },
  "&lap;": { "codepoints": [10885], "characters": "\u2A85" },
  "&Laplacetrf;": { "codepoints": [8466], "characters": "\u2112" },
  "&laquo;": { "codepoints": [171], "characters": "\u00AB" },
  "&laquo": { "codepoints": [171], "characters": "\u00AB" },
  "&larrb;": { "codepoints": [8676], "characters": "\u21E4" },
  "&larrbfs;": { "codepoints": [10527], "characters": "\u291F" },
  "&larr;": { "codepoints": [8592], "characters": "\u2190" },
  "&Larr;": { "codepoints": [8606], "characters": "\u219E" },
  "&lArr;": { "codepoints": [8656], "characters": "\u21D0" },
  "&larrfs;": { "codepoints": [10525], "characters": "\u291D" },
  "&larrhk;": { "codepoints": [8617], "characters": "\u21A9" },
  "&larrlp;": { "codepoints": [8619], "characters": "\u21AB" },
  "&larrpl;": { "codepoints": [10553], "characters": "\u2939" },
  "&larrsim;": { "codepoints": [10611], "characters": "\u2973" },
  "&larrtl;": { "codepoints": [8610], "characters": "\u21A2" },
  "&latail;": { "codepoints": [10521], "characters": "\u2919" },
  "&lAtail;": { "codepoints": [10523], "characters": "\u291B" },
  "&lat;": { "codepoints": [10923], "characters": "\u2AAB" },
  "&late;": { "codepoints": [10925], "characters": "\u2AAD" },
  "&lates;": { "codepoints": [10925, 65024], "characters": "\u2AAD\uFE00" },
  "&lbarr;": { "codepoints": [10508], "characters": "\u290C" },
  "&lBarr;": { "codepoints": [10510], "characters": "\u290E" },
  "&lbbrk;": { "codepoints": [10098], "characters": "\u2772" },
  "&lbrace;": { "codepoints": [123], "characters": "\u007B" },
  "&lbrack;": { "codepoints": [91], "characters": "\u005B" },
  "&lbrke;": { "codepoints": [10635], "characters": "\u298B" },
  "&lbrksld;": { "codepoints": [10639], "characters": "\u298F" },
  "&lbrkslu;": { "codepoints": [10637], "characters": "\u298D" },
  "&Lcaron;": { "codepoints": [317], "characters": "\u013D" },
  "&lcaron;": { "codepoints": [318], "characters": "\u013E" },
  "&Lcedil;": { "codepoints": [315], "characters": "\u013B" },
  "&lcedil;": { "codepoints": [316], "characters": "\u013C" },
  "&lceil;": { "codepoints": [8968], "characters": "\u2308" },
  "&lcub;": { "codepoints": [123], "characters": "\u007B" },
  "&Lcy;": { "codepoints": [1051], "characters": "\u041B" },
  "&lcy;": { "codepoints": [1083], "characters": "\u043B" },
  "&ldca;": { "codepoints": [10550], "characters": "\u2936" },
  "&ldquo;": { "codepoints": [8220], "characters": "\u201C" },
  "&ldquor;": { "codepoints": [8222], "characters": "\u201E" },
  "&ldrdhar;": { "codepoints": [10599], "characters": "\u2967" },
  "&ldrushar;": { "codepoints": [10571], "characters": "\u294B" },
  "&ldsh;": { "codepoints": [8626], "characters": "\u21B2" },
  "&le;": { "codepoints": [8804], "characters": "\u2264" },
  "&lE;": { "codepoints": [8806], "characters": "\u2266" },
  "&LeftAngleBracket;": { "codepoints": [10216], "characters": "\u27E8" },
  "&LeftArrowBar;": { "codepoints": [8676], "characters": "\u21E4" },
  "&leftarrow;": { "codepoints": [8592], "characters": "\u2190" },
  "&LeftArrow;": { "codepoints": [8592], "characters": "\u2190" },
  "&Leftarrow;": { "codepoints": [8656], "characters": "\u21D0" },
  "&LeftArrowRightArrow;": { "codepoints": [8646], "characters": "\u21C6" },
  "&leftarrowtail;": { "codepoints": [8610], "characters": "\u21A2" },
  "&LeftCeiling;": { "codepoints": [8968], "characters": "\u2308" },
  "&LeftDoubleBracket;": { "codepoints": [10214], "characters": "\u27E6" },
  "&LeftDownTeeVector;": { "codepoints": [10593], "characters": "\u2961" },
  "&LeftDownVectorBar;": { "codepoints": [10585], "characters": "\u2959" },
  "&LeftDownVector;": { "codepoints": [8643], "characters": "\u21C3" },
  "&LeftFloor;": { "codepoints": [8970], "characters": "\u230A" },
  "&leftharpoondown;": { "codepoints": [8637], "characters": "\u21BD" },
  "&leftharpoonup;": { "codepoints": [8636], "characters": "\u21BC" },
  "&leftleftarrows;": { "codepoints": [8647], "characters": "\u21C7" },
  "&leftrightarrow;": { "codepoints": [8596], "characters": "\u2194" },
  "&LeftRightArrow;": { "codepoints": [8596], "characters": "\u2194" },
  "&Leftrightarrow;": { "codepoints": [8660], "characters": "\u21D4" },
  "&leftrightarrows;": { "codepoints": [8646], "characters": "\u21C6" },
  "&leftrightharpoons;": { "codepoints": [8651], "characters": "\u21CB" },
  "&leftrightsquigarrow;": { "codepoints": [8621], "characters": "\u21AD" },
  "&LeftRightVector;": { "codepoints": [10574], "characters": "\u294E" },
  "&LeftTeeArrow;": { "codepoints": [8612], "characters": "\u21A4" },
  "&LeftTee;": { "codepoints": [8867], "characters": "\u22A3" },
  "&LeftTeeVector;": { "codepoints": [10586], "characters": "\u295A" },
  "&leftthreetimes;": { "codepoints": [8907], "characters": "\u22CB" },
  "&LeftTriangleBar;": { "codepoints": [10703], "characters": "\u29CF" },
  "&LeftTriangle;": { "codepoints": [8882], "characters": "\u22B2" },
  "&LeftTriangleEqual;": { "codepoints": [8884], "characters": "\u22B4" },
  "&LeftUpDownVector;": { "codepoints": [10577], "characters": "\u2951" },
  "&LeftUpTeeVector;": { "codepoints": [10592], "characters": "\u2960" },
  "&LeftUpVectorBar;": { "codepoints": [10584], "characters": "\u2958" },
  "&LeftUpVector;": { "codepoints": [8639], "characters": "\u21BF" },
  "&LeftVectorBar;": { "codepoints": [10578], "characters": "\u2952" },
  "&LeftVector;": { "codepoints": [8636], "characters": "\u21BC" },
  "&lEg;": { "codepoints": [10891], "characters": "\u2A8B" },
  "&leg;": { "codepoints": [8922], "characters": "\u22DA" },
  "&leq;": { "codepoints": [8804], "characters": "\u2264" },
  "&leqq;": { "codepoints": [8806], "characters": "\u2266" },
  "&leqslant;": { "codepoints": [10877], "characters": "\u2A7D" },
  "&lescc;": { "codepoints": [10920], "characters": "\u2AA8" },
  "&les;": { "codepoints": [10877], "characters": "\u2A7D" },
  "&lesdot;": { "codepoints": [10879], "characters": "\u2A7F" },
  "&lesdoto;": { "codepoints": [10881], "characters": "\u2A81" },
  "&lesdotor;": { "codepoints": [10883], "characters": "\u2A83" },
  "&lesg;": { "codepoints": [8922, 65024], "characters": "\u22DA\uFE00" },
  "&lesges;": { "codepoints": [10899], "characters": "\u2A93" },
  "&lessapprox;": { "codepoints": [10885], "characters": "\u2A85" },
  "&lessdot;": { "codepoints": [8918], "characters": "\u22D6" },
  "&lesseqgtr;": { "codepoints": [8922], "characters": "\u22DA" },
  "&lesseqqgtr;": { "codepoints": [10891], "characters": "\u2A8B" },
  "&LessEqualGreater;": { "codepoints": [8922], "characters": "\u22DA" },
  "&LessFullEqual;": { "codepoints": [8806], "characters": "\u2266" },
  "&LessGreater;": { "codepoints": [8822], "characters": "\u2276" },
  "&lessgtr;": { "codepoints": [8822], "characters": "\u2276" },
  "&LessLess;": { "codepoints": [10913], "characters": "\u2AA1" },
  "&lesssim;": { "codepoints": [8818], "characters": "\u2272" },
  "&LessSlantEqual;": { "codepoints": [10877], "characters": "\u2A7D" },
  "&LessTilde;": { "codepoints": [8818], "characters": "\u2272" },
  "&lfisht;": { "codepoints": [10620], "characters": "\u297C" },
  "&lfloor;": { "codepoints": [8970], "characters": "\u230A" },
  "&Lfr;": { "codepoints": [120079], "characters": "\uD835\uDD0F" },
  "&lfr;": { "codepoints": [120105], "characters": "\uD835\uDD29" },
  "&lg;": { "codepoints": [8822], "characters": "\u2276" },
  "&lgE;": { "codepoints": [10897], "characters": "\u2A91" },
  "&lHar;": { "codepoints": [10594], "characters": "\u2962" },
  "&lhard;": { "codepoints": [8637], "characters": "\u21BD" },
  "&lharu;": { "codepoints": [8636], "characters": "\u21BC" },
  "&lharul;": { "codepoints": [10602], "characters": "\u296A" },
  "&lhblk;": { "codepoints": [9604], "characters": "\u2584" },
  "&LJcy;": { "codepoints": [1033], "characters": "\u0409" },
  "&ljcy;": { "codepoints": [1113], "characters": "\u0459" },
  "&llarr;": { "codepoints": [8647], "characters": "\u21C7" },
  "&ll;": { "codepoints": [8810], "characters": "\u226A" },
  "&Ll;": { "codepoints": [8920], "characters": "\u22D8" },
  "&llcorner;": { "codepoints": [8990], "characters": "\u231E" },
  "&Lleftarrow;": { "codepoints": [8666], "characters": "\u21DA" },
  "&llhard;": { "codepoints": [10603], "characters": "\u296B" },
  "&lltri;": { "codepoints": [9722], "characters": "\u25FA" },
  "&Lmidot;": { "codepoints": [319], "characters": "\u013F" },
  "&lmidot;": { "codepoints": [320], "characters": "\u0140" },
  "&lmoustache;": { "codepoints": [9136], "characters": "\u23B0" },
  "&lmoust;": { "codepoints": [9136], "characters": "\u23B0" },
  "&lnap;": { "codepoints": [10889], "characters": "\u2A89" },
  "&lnapprox;": { "codepoints": [10889], "characters": "\u2A89" },
  "&lne;": { "codepoints": [10887], "characters": "\u2A87" },
  "&lnE;": { "codepoints": [8808], "characters": "\u2268" },
  "&lneq;": { "codepoints": [10887], "characters": "\u2A87" },
  "&lneqq;": { "codepoints": [8808], "characters": "\u2268" },
  "&lnsim;": { "codepoints": [8934], "characters": "\u22E6" },
  "&loang;": { "codepoints": [10220], "characters": "\u27EC" },
  "&loarr;": { "codepoints": [8701], "characters": "\u21FD" },
  "&lobrk;": { "codepoints": [10214], "characters": "\u27E6" },
  "&longleftarrow;": { "codepoints": [10229], "characters": "\u27F5" },
  "&LongLeftArrow;": { "codepoints": [10229], "characters": "\u27F5" },
  "&Longleftarrow;": { "codepoints": [10232], "characters": "\u27F8" },
  "&longleftrightarrow;": { "codepoints": [10231], "characters": "\u27F7" },
  "&LongLeftRightArrow;": { "codepoints": [10231], "characters": "\u27F7" },
  "&Longleftrightarrow;": { "codepoints": [10234], "characters": "\u27FA" },
  "&longmapsto;": { "codepoints": [10236], "characters": "\u27FC" },
  "&longrightarrow;": { "codepoints": [10230], "characters": "\u27F6" },
  "&LongRightArrow;": { "codepoints": [10230], "characters": "\u27F6" },
  "&Longrightarrow;": { "codepoints": [10233], "characters": "\u27F9" },
  "&looparrowleft;": { "codepoints": [8619], "characters": "\u21AB" },
  "&looparrowright;": { "codepoints": [8620], "characters": "\u21AC" },
  "&lopar;": { "codepoints": [10629], "characters": "\u2985" },
  "&Lopf;": { "codepoints": [120131], "characters": "\uD835\uDD43" },
  "&lopf;": { "codepoints": [120157], "characters": "\uD835\uDD5D" },
  "&loplus;": { "codepoints": [10797], "characters": "\u2A2D" },
  "&lotimes;": { "codepoints": [10804], "characters": "\u2A34" },
  "&lowast;": { "codepoints": [8727], "characters": "\u2217" },
  "&lowbar;": { "codepoints": [95], "characters": "\u005F" },
  "&LowerLeftArrow;": { "codepoints": [8601], "characters": "\u2199" },
  "&LowerRightArrow;": { "codepoints": [8600], "characters": "\u2198" },
  "&loz;": { "codepoints": [9674], "characters": "\u25CA" },
  "&lozenge;": { "codepoints": [9674], "characters": "\u25CA" },
  "&lozf;": { "codepoints": [10731], "characters": "\u29EB" },
  "&lpar;": { "codepoints": [40], "characters": "\u0028" },
  "&lparlt;": { "codepoints": [10643], "characters": "\u2993" },
  "&lrarr;": { "codepoints": [8646], "characters": "\u21C6" },
  "&lrcorner;": { "codepoints": [8991], "characters": "\u231F" },
  "&lrhar;": { "codepoints": [8651], "characters": "\u21CB" },
  "&lrhard;": { "codepoints": [10605], "characters": "\u296D" },
  "&lrm;": { "codepoints": [8206], "characters": "\u200E" },
  "&lrtri;": { "codepoints": [8895], "characters": "\u22BF" },
  "&lsaquo;": { "codepoints": [8249], "characters": "\u2039" },
  "&lscr;": { "codepoints": [120001], "characters": "\uD835\uDCC1" },
  "&Lscr;": { "codepoints": [8466], "characters": "\u2112" },
  "&lsh;": { "codepoints": [8624], "characters": "\u21B0" },
  "&Lsh;": { "codepoints": [8624], "characters": "\u21B0" },
  "&lsim;": { "codepoints": [8818], "characters": "\u2272" },
  "&lsime;": { "codepoints": [10893], "characters": "\u2A8D" },
  "&lsimg;": { "codepoints": [10895], "characters": "\u2A8F" },
  "&lsqb;": { "codepoints": [91], "characters": "\u005B" },
  "&lsquo;": { "codepoints": [8216], "characters": "\u2018" },
  "&lsquor;": { "codepoints": [8218], "characters": "\u201A" },
  "&Lstrok;": { "codepoints": [321], "characters": "\u0141" },
  "&lstrok;": { "codepoints": [322], "characters": "\u0142" },
  "&ltcc;": { "codepoints": [10918], "characters": "\u2AA6" },
  "&ltcir;": { "codepoints": [10873], "characters": "\u2A79" },
  "&lt;": { "codepoints": [60], "characters": "\u003C" },
  "&lt": { "codepoints": [60], "characters": "\u003C" },
  "&LT;": { "codepoints": [60], "characters": "\u003C" },
  "&LT": { "codepoints": [60], "characters": "\u003C" },
  "&Lt;": { "codepoints": [8810], "characters": "\u226A" },
  "&ltdot;": { "codepoints": [8918], "characters": "\u22D6" },
  "&lthree;": { "codepoints": [8907], "characters": "\u22CB" },
  "&ltimes;": { "codepoints": [8905], "characters": "\u22C9" },
  "&ltlarr;": { "codepoints": [10614], "characters": "\u2976" },
  "&ltquest;": { "codepoints": [10875], "characters": "\u2A7B" },
  "&ltri;": { "codepoints": [9667], "characters": "\u25C3" },
  "&ltrie;": { "codepoints": [8884], "characters": "\u22B4" },
  "&ltrif;": { "codepoints": [9666], "characters": "\u25C2" },
  "&ltrPar;": { "codepoints": [10646], "characters": "\u2996" },
  "&lurdshar;": { "codepoints": [10570], "characters": "\u294A" },
  "&luruhar;": { "codepoints": [10598], "characters": "\u2966" },
  "&lvertneqq;": { "codepoints": [8808, 65024], "characters": "\u2268\uFE00" },
  "&lvnE;": { "codepoints": [8808, 65024], "characters": "\u2268\uFE00" },
  "&macr;": { "codepoints": [175], "characters": "\u00AF" },
  "&macr": { "codepoints": [175], "characters": "\u00AF" },
  "&male;": { "codepoints": [9794], "characters": "\u2642" },
  "&malt;": { "codepoints": [10016], "characters": "\u2720" },
  "&maltese;": { "codepoints": [10016], "characters": "\u2720" },
  "&Map;": { "codepoints": [10501], "characters": "\u2905" },
  "&map;": { "codepoints": [8614], "characters": "\u21A6" },
  "&mapsto;": { "codepoints": [8614], "characters": "\u21A6" },
  "&mapstodown;": { "codepoints": [8615], "characters": "\u21A7" },
  "&mapstoleft;": { "codepoints": [8612], "characters": "\u21A4" },
  "&mapstoup;": { "codepoints": [8613], "characters": "\u21A5" },
  "&marker;": { "codepoints": [9646], "characters": "\u25AE" },
  "&mcomma;": { "codepoints": [10793], "characters": "\u2A29" },
  "&Mcy;": { "codepoints": [1052], "characters": "\u041C" },
  "&mcy;": { "codepoints": [1084], "characters": "\u043C" },
  "&mdash;": { "codepoints": [8212], "characters": "\u2014" },
  "&mDDot;": { "codepoints": [8762], "characters": "\u223A" },
  "&measuredangle;": { "codepoints": [8737], "characters": "\u2221" },
  "&MediumSpace;": { "codepoints": [8287], "characters": "\u205F" },
  "&Mellintrf;": { "codepoints": [8499], "characters": "\u2133" },
  "&Mfr;": { "codepoints": [120080], "characters": "\uD835\uDD10" },
  "&mfr;": { "codepoints": [120106], "characters": "\uD835\uDD2A" },
  "&mho;": { "codepoints": [8487], "characters": "\u2127" },
  "&micro;": { "codepoints": [181], "characters": "\u00B5" },
  "&micro": { "codepoints": [181], "characters": "\u00B5" },
  "&midast;": { "codepoints": [42], "characters": "\u002A" },
  "&midcir;": { "codepoints": [10992], "characters": "\u2AF0" },
  "&mid;": { "codepoints": [8739], "characters": "\u2223" },
  "&middot;": { "codepoints": [183], "characters": "\u00B7" },
  "&middot": { "codepoints": [183], "characters": "\u00B7" },
  "&minusb;": { "codepoints": [8863], "characters": "\u229F" },
  "&minus;": { "codepoints": [8722], "characters": "\u2212" },
  "&minusd;": { "codepoints": [8760], "characters": "\u2238" },
  "&minusdu;": { "codepoints": [10794], "characters": "\u2A2A" },
  "&MinusPlus;": { "codepoints": [8723], "characters": "\u2213" },
  "&mlcp;": { "codepoints": [10971], "characters": "\u2ADB" },
  "&mldr;": { "codepoints": [8230], "characters": "\u2026" },
  "&mnplus;": { "codepoints": [8723], "characters": "\u2213" },
  "&models;": { "codepoints": [8871], "characters": "\u22A7" },
  "&Mopf;": { "codepoints": [120132], "characters": "\uD835\uDD44" },
  "&mopf;": { "codepoints": [120158], "characters": "\uD835\uDD5E" },
  "&mp;": { "codepoints": [8723], "characters": "\u2213" },
  "&mscr;": { "codepoints": [120002], "characters": "\uD835\uDCC2" },
  "&Mscr;": { "codepoints": [8499], "characters": "\u2133" },
  "&mstpos;": { "codepoints": [8766], "characters": "\u223E" },
  "&Mu;": { "codepoints": [924], "characters": "\u039C" },
  "&mu;": { "codepoints": [956], "characters": "\u03BC" },
  "&multimap;": { "codepoints": [8888], "characters": "\u22B8" },
  "&mumap;": { "codepoints": [8888], "characters": "\u22B8" },
  "&nabla;": { "codepoints": [8711], "characters": "\u2207" },
  "&Nacute;": { "codepoints": [323], "characters": "\u0143" },
  "&nacute;": { "codepoints": [324], "characters": "\u0144" },
  "&nang;": { "codepoints": [8736, 8402], "characters": "\u2220\u20D2" },
  "&nap;": { "codepoints": [8777], "characters": "\u2249" },
  "&napE;": { "codepoints": [10864, 824], "characters": "\u2A70\u0338" },
  "&napid;": { "codepoints": [8779, 824], "characters": "\u224B\u0338" },
  "&napos;": { "codepoints": [329], "characters": "\u0149" },
  "&napprox;": { "codepoints": [8777], "characters": "\u2249" },
  "&natural;": { "codepoints": [9838], "characters": "\u266E" },
  "&naturals;": { "codepoints": [8469], "characters": "\u2115" },
  "&natur;": { "codepoints": [9838], "characters": "\u266E" },
  "&nbsp;": { "codepoints": [160], "characters": "\u00A0" },
  "&nbsp": { "codepoints": [160], "characters": "\u00A0" },
  "&nbump;": { "codepoints": [8782, 824], "characters": "\u224E\u0338" },
  "&nbumpe;": { "codepoints": [8783, 824], "characters": "\u224F\u0338" },
  "&ncap;": { "codepoints": [10819], "characters": "\u2A43" },
  "&Ncaron;": { "codepoints": [327], "characters": "\u0147" },
  "&ncaron;": { "codepoints": [328], "characters": "\u0148" },
  "&Ncedil;": { "codepoints": [325], "characters": "\u0145" },
  "&ncedil;": { "codepoints": [326], "characters": "\u0146" },
  "&ncong;": { "codepoints": [8775], "characters": "\u2247" },
  "&ncongdot;": { "codepoints": [10861, 824], "characters": "\u2A6D\u0338" },
  "&ncup;": { "codepoints": [10818], "characters": "\u2A42" },
  "&Ncy;": { "codepoints": [1053], "characters": "\u041D" },
  "&ncy;": { "codepoints": [1085], "characters": "\u043D" },
  "&ndash;": { "codepoints": [8211], "characters": "\u2013" },
  "&nearhk;": { "codepoints": [10532], "characters": "\u2924" },
  "&nearr;": { "codepoints": [8599], "characters": "\u2197" },
  "&neArr;": { "codepoints": [8663], "characters": "\u21D7" },
  "&nearrow;": { "codepoints": [8599], "characters": "\u2197" },
  "&ne;": { "codepoints": [8800], "characters": "\u2260" },
  "&nedot;": { "codepoints": [8784, 824], "characters": "\u2250\u0338" },
  "&NegativeMediumSpace;": { "codepoints": [8203], "characters": "\u200B" },
  "&NegativeThickSpace;": { "codepoints": [8203], "characters": "\u200B" },
  "&NegativeThinSpace;": { "codepoints": [8203], "characters": "\u200B" },
  "&NegativeVeryThinSpace;": { "codepoints": [8203], "characters": "\u200B" },
  "&nequiv;": { "codepoints": [8802], "characters": "\u2262" },
  "&nesear;": { "codepoints": [10536], "characters": "\u2928" },
  "&nesim;": { "codepoints": [8770, 824], "characters": "\u2242\u0338" },
  "&NestedGreaterGreater;": { "codepoints": [8811], "characters": "\u226B" },
  "&NestedLessLess;": { "codepoints": [8810], "characters": "\u226A" },
  "&NewLine;": { "codepoints": [10], "characters": "\u000A" },
  "&nexist;": { "codepoints": [8708], "characters": "\u2204" },
  "&nexists;": { "codepoints": [8708], "characters": "\u2204" },
  "&Nfr;": { "codepoints": [120081], "characters": "\uD835\uDD11" },
  "&nfr;": { "codepoints": [120107], "characters": "\uD835\uDD2B" },
  "&ngE;": { "codepoints": [8807, 824], "characters": "\u2267\u0338" },
  "&nge;": { "codepoints": [8817], "characters": "\u2271" },
  "&ngeq;": { "codepoints": [8817], "characters": "\u2271" },
  "&ngeqq;": { "codepoints": [8807, 824], "characters": "\u2267\u0338" },
  "&ngeqslant;": { "codepoints": [10878, 824], "characters": "\u2A7E\u0338" },
  "&nges;": { "codepoints": [10878, 824], "characters": "\u2A7E\u0338" },
  "&nGg;": { "codepoints": [8921, 824], "characters": "\u22D9\u0338" },
  "&ngsim;": { "codepoints": [8821], "characters": "\u2275" },
  "&nGt;": { "codepoints": [8811, 8402], "characters": "\u226B\u20D2" },
  "&ngt;": { "codepoints": [8815], "characters": "\u226F" },
  "&ngtr;": { "codepoints": [8815], "characters": "\u226F" },
  "&nGtv;": { "codepoints": [8811, 824], "characters": "\u226B\u0338" },
  "&nharr;": { "codepoints": [8622], "characters": "\u21AE" },
  "&nhArr;": { "codepoints": [8654], "characters": "\u21CE" },
  "&nhpar;": { "codepoints": [10994], "characters": "\u2AF2" },
  "&ni;": { "codepoints": [8715], "characters": "\u220B" },
  "&nis;": { "codepoints": [8956], "characters": "\u22FC" },
  "&nisd;": { "codepoints": [8954], "characters": "\u22FA" },
  "&niv;": { "codepoints": [8715], "characters": "\u220B" },
  "&NJcy;": { "codepoints": [1034], "characters": "\u040A" },
  "&njcy;": { "codepoints": [1114], "characters": "\u045A" },
  "&nlarr;": { "codepoints": [8602], "characters": "\u219A" },
  "&nlArr;": { "codepoints": [8653], "characters": "\u21CD" },
  "&nldr;": { "codepoints": [8229], "characters": "\u2025" },
  "&nlE;": { "codepoints": [8806, 824], "characters": "\u2266\u0338" },
  "&nle;": { "codepoints": [8816], "characters": "\u2270" },
  "&nleftarrow;": { "codepoints": [8602], "characters": "\u219A" },
  "&nLeftarrow;": { "codepoints": [8653], "characters": "\u21CD" },
  "&nleftrightarrow;": { "codepoints": [8622], "characters": "\u21AE" },
  "&nLeftrightarrow;": { "codepoints": [8654], "characters": "\u21CE" },
  "&nleq;": { "codepoints": [8816], "characters": "\u2270" },
  "&nleqq;": { "codepoints": [8806, 824], "characters": "\u2266\u0338" },
  "&nleqslant;": { "codepoints": [10877, 824], "characters": "\u2A7D\u0338" },
  "&nles;": { "codepoints": [10877, 824], "characters": "\u2A7D\u0338" },
  "&nless;": { "codepoints": [8814], "characters": "\u226E" },
  "&nLl;": { "codepoints": [8920, 824], "characters": "\u22D8\u0338" },
  "&nlsim;": { "codepoints": [8820], "characters": "\u2274" },
  "&nLt;": { "codepoints": [8810, 8402], "characters": "\u226A\u20D2" },
  "&nlt;": { "codepoints": [8814], "characters": "\u226E" },
  "&nltri;": { "codepoints": [8938], "characters": "\u22EA" },
  "&nltrie;": { "codepoints": [8940], "characters": "\u22EC" },
  "&nLtv;": { "codepoints": [8810, 824], "characters": "\u226A\u0338" },
  "&nmid;": { "codepoints": [8740], "characters": "\u2224" },
  "&NoBreak;": { "codepoints": [8288], "characters": "\u2060" },
  "&NonBreakingSpace;": { "codepoints": [160], "characters": "\u00A0" },
  "&nopf;": { "codepoints": [120159], "characters": "\uD835\uDD5F" },
  "&Nopf;": { "codepoints": [8469], "characters": "\u2115" },
  "&Not;": { "codepoints": [10988], "characters": "\u2AEC" },
  "&not;": { "codepoints": [172], "characters": "\u00AC" },
  "&not": { "codepoints": [172], "characters": "\u00AC" },
  "&NotCongruent;": { "codepoints": [8802], "characters": "\u2262" },
  "&NotCupCap;": { "codepoints": [8813], "characters": "\u226D" },
  "&NotDoubleVerticalBar;": { "codepoints": [8742], "characters": "\u2226" },
  "&NotElement;": { "codepoints": [8713], "characters": "\u2209" },
  "&NotEqual;": { "codepoints": [8800], "characters": "\u2260" },
  "&NotEqualTilde;": { "codepoints": [8770, 824], "characters": "\u2242\u0338" },
  "&NotExists;": { "codepoints": [8708], "characters": "\u2204" },
  "&NotGreater;": { "codepoints": [8815], "characters": "\u226F" },
  "&NotGreaterEqual;": { "codepoints": [8817], "characters": "\u2271" },
  "&NotGreaterFullEqual;": { "codepoints": [8807, 824], "characters": "\u2267\u0338" },
  "&NotGreaterGreater;": { "codepoints": [8811, 824], "characters": "\u226B\u0338" },
  "&NotGreaterLess;": { "codepoints": [8825], "characters": "\u2279" },
  "&NotGreaterSlantEqual;": { "codepoints": [10878, 824], "characters": "\u2A7E\u0338" },
  "&NotGreaterTilde;": { "codepoints": [8821], "characters": "\u2275" },
  "&NotHumpDownHump;": { "codepoints": [8782, 824], "characters": "\u224E\u0338" },
  "&NotHumpEqual;": { "codepoints": [8783, 824], "characters": "\u224F\u0338" },
  "&notin;": { "codepoints": [8713], "characters": "\u2209" },
  "&notindot;": { "codepoints": [8949, 824], "characters": "\u22F5\u0338" },
  "&notinE;": { "codepoints": [8953, 824], "characters": "\u22F9\u0338" },
  "&notinva;": { "codepoints": [8713], "characters": "\u2209" },
  "&notinvb;": { "codepoints": [8951], "characters": "\u22F7" },
  "&notinvc;": { "codepoints": [8950], "characters": "\u22F6" },
  "&NotLeftTriangleBar;": { "codepoints": [10703, 824], "characters": "\u29CF\u0338" },
  "&NotLeftTriangle;": { "codepoints": [8938], "characters": "\u22EA" },
  "&NotLeftTriangleEqual;": { "codepoints": [8940], "characters": "\u22EC" },
  "&NotLess;": { "codepoints": [8814], "characters": "\u226E" },
  "&NotLessEqual;": { "codepoints": [8816], "characters": "\u2270" },
  "&NotLessGreater;": { "codepoints": [8824], "characters": "\u2278" },
  "&NotLessLess;": { "codepoints": [8810, 824], "characters": "\u226A\u0338" },
  "&NotLessSlantEqual;": { "codepoints": [10877, 824], "characters": "\u2A7D\u0338" },
  "&NotLessTilde;": { "codepoints": [8820], "characters": "\u2274" },
  "&NotNestedGreaterGreater;": { "codepoints": [10914, 824], "characters": "\u2AA2\u0338" },
  "&NotNestedLessLess;": { "codepoints": [10913, 824], "characters": "\u2AA1\u0338" },
  "&notni;": { "codepoints": [8716], "characters": "\u220C" },
  "&notniva;": { "codepoints": [8716], "characters": "\u220C" },
  "&notnivb;": { "codepoints": [8958], "characters": "\u22FE" },
  "&notnivc;": { "codepoints": [8957], "characters": "\u22FD" },
  "&NotPrecedes;": { "codepoints": [8832], "characters": "\u2280" },
  "&NotPrecedesEqual;": { "codepoints": [10927, 824], "characters": "\u2AAF\u0338" },
  "&NotPrecedesSlantEqual;": { "codepoints": [8928], "characters": "\u22E0" },
  "&NotReverseElement;": { "codepoints": [8716], "characters": "\u220C" },
  "&NotRightTriangleBar;": { "codepoints": [10704, 824], "characters": "\u29D0\u0338" },
  "&NotRightTriangle;": { "codepoints": [8939], "characters": "\u22EB" },
  "&NotRightTriangleEqual;": { "codepoints": [8941], "characters": "\u22ED" },
  "&NotSquareSubset;": { "codepoints": [8847, 824], "characters": "\u228F\u0338" },
  "&NotSquareSubsetEqual;": { "codepoints": [8930], "characters": "\u22E2" },
  "&NotSquareSuperset;": { "codepoints": [8848, 824], "characters": "\u2290\u0338" },
  "&NotSquareSupersetEqual;": { "codepoints": [8931], "characters": "\u22E3" },
  "&NotSubset;": { "codepoints": [8834, 8402], "characters": "\u2282\u20D2" },
  "&NotSubsetEqual;": { "codepoints": [8840], "characters": "\u2288" },
  "&NotSucceeds;": { "codepoints": [8833], "characters": "\u2281" },
  "&NotSucceedsEqual;": { "codepoints": [10928, 824], "characters": "\u2AB0\u0338" },
  "&NotSucceedsSlantEqual;": { "codepoints": [8929], "characters": "\u22E1" },
  "&NotSucceedsTilde;": { "codepoints": [8831, 824], "characters": "\u227F\u0338" },
  "&NotSuperset;": { "codepoints": [8835, 8402], "characters": "\u2283\u20D2" },
  "&NotSupersetEqual;": { "codepoints": [8841], "characters": "\u2289" },
  "&NotTilde;": { "codepoints": [8769], "characters": "\u2241" },
  "&NotTildeEqual;": { "codepoints": [8772], "characters": "\u2244" },
  "&NotTildeFullEqual;": { "codepoints": [8775], "characters": "\u2247" },
  "&NotTildeTilde;": { "codepoints": [8777], "characters": "\u2249" },
  "&NotVerticalBar;": { "codepoints": [8740], "characters": "\u2224" },
  "&nparallel;": { "codepoints": [8742], "characters": "\u2226" },
  "&npar;": { "codepoints": [8742], "characters": "\u2226" },
  "&nparsl;": { "codepoints": [11005, 8421], "characters": "\u2AFD\u20E5" },
  "&npart;": { "codepoints": [8706, 824], "characters": "\u2202\u0338" },
  "&npolint;": { "codepoints": [10772], "characters": "\u2A14" },
  "&npr;": { "codepoints": [8832], "characters": "\u2280" },
  "&nprcue;": { "codepoints": [8928], "characters": "\u22E0" },
  "&nprec;": { "codepoints": [8832], "characters": "\u2280" },
  "&npreceq;": { "codepoints": [10927, 824], "characters": "\u2AAF\u0338" },
  "&npre;": { "codepoints": [10927, 824], "characters": "\u2AAF\u0338" },
  "&nrarrc;": { "codepoints": [10547, 824], "characters": "\u2933\u0338" },
  "&nrarr;": { "codepoints": [8603], "characters": "\u219B" },
  "&nrArr;": { "codepoints": [8655], "characters": "\u21CF" },
  "&nrarrw;": { "codepoints": [8605, 824], "characters": "\u219D\u0338" },
  "&nrightarrow;": { "codepoints": [8603], "characters": "\u219B" },
  "&nRightarrow;": { "codepoints": [8655], "characters": "\u21CF" },
  "&nrtri;": { "codepoints": [8939], "characters": "\u22EB" },
  "&nrtrie;": { "codepoints": [8941], "characters": "\u22ED" },
  "&nsc;": { "codepoints": [8833], "characters": "\u2281" },
  "&nsccue;": { "codepoints": [8929], "characters": "\u22E1" },
  "&nsce;": { "codepoints": [10928, 824], "characters": "\u2AB0\u0338" },
  "&Nscr;": { "codepoints": [119977], "characters": "\uD835\uDCA9" },
  "&nscr;": { "codepoints": [120003], "characters": "\uD835\uDCC3" },
  "&nshortmid;": { "codepoints": [8740], "characters": "\u2224" },
  "&nshortparallel;": { "codepoints": [8742], "characters": "\u2226" },
  "&nsim;": { "codepoints": [8769], "characters": "\u2241" },
  "&nsime;": { "codepoints": [8772], "characters": "\u2244" },
  "&nsimeq;": { "codepoints": [8772], "characters": "\u2244" },
  "&nsmid;": { "codepoints": [8740], "characters": "\u2224" },
  "&nspar;": { "codepoints": [8742], "characters": "\u2226" },
  "&nsqsube;": { "codepoints": [8930], "characters": "\u22E2" },
  "&nsqsupe;": { "codepoints": [8931], "characters": "\u22E3" },
  "&nsub;": { "codepoints": [8836], "characters": "\u2284" },
  "&nsubE;": { "codepoints": [10949, 824], "characters": "\u2AC5\u0338" },
  "&nsube;": { "codepoints": [8840], "characters": "\u2288" },
  "&nsubset;": { "codepoints": [8834, 8402], "characters": "\u2282\u20D2" },
  "&nsubseteq;": { "codepoints": [8840], "characters": "\u2288" },
  "&nsubseteqq;": { "codepoints": [10949, 824], "characters": "\u2AC5\u0338" },
  "&nsucc;": { "codepoints": [8833], "characters": "\u2281" },
  "&nsucceq;": { "codepoints": [10928, 824], "characters": "\u2AB0\u0338" },
  "&nsup;": { "codepoints": [8837], "characters": "\u2285" },
  "&nsupE;": { "codepoints": [10950, 824], "characters": "\u2AC6\u0338" },
  "&nsupe;": { "codepoints": [8841], "characters": "\u2289" },
  "&nsupset;": { "codepoints": [8835, 8402], "characters": "\u2283\u20D2" },
  "&nsupseteq;": { "codepoints": [8841], "characters": "\u2289" },
  "&nsupseteqq;": { "codepoints": [10950, 824], "characters": "\u2AC6\u0338" },
  "&ntgl;": { "codepoints": [8825], "characters": "\u2279" },
  "&Ntilde;": { "codepoints": [209], "characters": "\u00D1" },
  "&Ntilde": { "codepoints": [209], "characters": "\u00D1" },
  "&ntilde;": { "codepoints": [241], "characters": "\u00F1" },
  "&ntilde": { "codepoints": [241], "characters": "\u00F1" },
  "&ntlg;": { "codepoints": [8824], "characters": "\u2278" },
  "&ntriangleleft;": { "codepoints": [8938], "characters": "\u22EA" },
  "&ntrianglelefteq;": { "codepoints": [8940], "characters": "\u22EC" },
  "&ntriangleright;": { "codepoints": [8939], "characters": "\u22EB" },
  "&ntrianglerighteq;": { "codepoints": [8941], "characters": "\u22ED" },
  "&Nu;": { "codepoints": [925], "characters": "\u039D" },
  "&nu;": { "codepoints": [957], "characters": "\u03BD" },
  "&num;": { "codepoints": [35], "characters": "\u0023" },
  "&numero;": { "codepoints": [8470], "characters": "\u2116" },
  "&numsp;": { "codepoints": [8199], "characters": "\u2007" },
  "&nvap;": { "codepoints": [8781, 8402], "characters": "\u224D\u20D2" },
  "&nvdash;": { "codepoints": [8876], "characters": "\u22AC" },
  "&nvDash;": { "codepoints": [8877], "characters": "\u22AD" },
  "&nVdash;": { "codepoints": [8878], "characters": "\u22AE" },
  "&nVDash;": { "codepoints": [8879], "characters": "\u22AF" },
  "&nvge;": { "codepoints": [8805, 8402], "characters": "\u2265\u20D2" },
  "&nvgt;": { "codepoints": [62, 8402], "characters": "\u003E\u20D2" },
  "&nvHarr;": { "codepoints": [10500], "characters": "\u2904" },
  "&nvinfin;": { "codepoints": [10718], "characters": "\u29DE" },
  "&nvlArr;": { "codepoints": [10498], "characters": "\u2902" },
  "&nvle;": { "codepoints": [8804, 8402], "characters": "\u2264\u20D2" },
  "&nvlt;": { "codepoints": [60, 8402], "characters": "\u003C\u20D2" },
  "&nvltrie;": { "codepoints": [8884, 8402], "characters": "\u22B4\u20D2" },
  "&nvrArr;": { "codepoints": [10499], "characters": "\u2903" },
  "&nvrtrie;": { "codepoints": [8885, 8402], "characters": "\u22B5\u20D2" },
  "&nvsim;": { "codepoints": [8764, 8402], "characters": "\u223C\u20D2" },
  "&nwarhk;": { "codepoints": [10531], "characters": "\u2923" },
  "&nwarr;": { "codepoints": [8598], "characters": "\u2196" },
  "&nwArr;": { "codepoints": [8662], "characters": "\u21D6" },
  "&nwarrow;": { "codepoints": [8598], "characters": "\u2196" },
  "&nwnear;": { "codepoints": [10535], "characters": "\u2927" },
  "&Oacute;": { "codepoints": [211], "characters": "\u00D3" },
  "&Oacute": { "codepoints": [211], "characters": "\u00D3" },
  "&oacute;": { "codepoints": [243], "characters": "\u00F3" },
  "&oacute": { "codepoints": [243], "characters": "\u00F3" },
  "&oast;": { "codepoints": [8859], "characters": "\u229B" },
  "&Ocirc;": { "codepoints": [212], "characters": "\u00D4" },
  "&Ocirc": { "codepoints": [212], "characters": "\u00D4" },
  "&ocirc;": { "codepoints": [244], "characters": "\u00F4" },
  "&ocirc": { "codepoints": [244], "characters": "\u00F4" },
  "&ocir;": { "codepoints": [8858], "characters": "\u229A" },
  "&Ocy;": { "codepoints": [1054], "characters": "\u041E" },
  "&ocy;": { "codepoints": [1086], "characters": "\u043E" },
  "&odash;": { "codepoints": [8861], "characters": "\u229D" },
  "&Odblac;": { "codepoints": [336], "characters": "\u0150" },
  "&odblac;": { "codepoints": [337], "characters": "\u0151" },
  "&odiv;": { "codepoints": [10808], "characters": "\u2A38" },
  "&odot;": { "codepoints": [8857], "characters": "\u2299" },
  "&odsold;": { "codepoints": [10684], "characters": "\u29BC" },
  "&OElig;": { "codepoints": [338], "characters": "\u0152" },
  "&oelig;": { "codepoints": [339], "characters": "\u0153" },
  "&ofcir;": { "codepoints": [10687], "characters": "\u29BF" },
  "&Ofr;": { "codepoints": [120082], "characters": "\uD835\uDD12" },
  "&ofr;": { "codepoints": [120108], "characters": "\uD835\uDD2C" },
  "&ogon;": { "codepoints": [731], "characters": "\u02DB" },
  "&Ograve;": { "codepoints": [210], "characters": "\u00D2" },
  "&Ograve": { "codepoints": [210], "characters": "\u00D2" },
  "&ograve;": { "codepoints": [242], "characters": "\u00F2" },
  "&ograve": { "codepoints": [242], "characters": "\u00F2" },
  "&ogt;": { "codepoints": [10689], "characters": "\u29C1" },
  "&ohbar;": { "codepoints": [10677], "characters": "\u29B5" },
  "&ohm;": { "codepoints": [937], "characters": "\u03A9" },
  "&oint;": { "codepoints": [8750], "characters": "\u222E" },
  "&olarr;": { "codepoints": [8634], "characters": "\u21BA" },
  "&olcir;": { "codepoints": [10686], "characters": "\u29BE" },
  "&olcross;": { "codepoints": [10683], "characters": "\u29BB" },
  "&oline;": { "codepoints": [8254], "characters": "\u203E" },
  "&olt;": { "codepoints": [10688], "characters": "\u29C0" },
  "&Omacr;": { "codepoints": [332], "characters": "\u014C" },
  "&omacr;": { "codepoints": [333], "characters": "\u014D" },
  "&Omega;": { "codepoints": [937], "characters": "\u03A9" },
  "&omega;": { "codepoints": [969], "characters": "\u03C9" },
  "&Omicron;": { "codepoints": [927], "characters": "\u039F" },
  "&omicron;": { "codepoints": [959], "characters": "\u03BF" },
  "&omid;": { "codepoints": [10678], "characters": "\u29B6" },
  "&ominus;": { "codepoints": [8854], "characters": "\u2296" },
  "&Oopf;": { "codepoints": [120134], "characters": "\uD835\uDD46" },
  "&oopf;": { "codepoints": [120160], "characters": "\uD835\uDD60" },
  "&opar;": { "codepoints": [10679], "characters": "\u29B7" },
  "&OpenCurlyDoubleQuote;": { "codepoints": [8220], "characters": "\u201C" },
  "&OpenCurlyQuote;": { "codepoints": [8216], "characters": "\u2018" },
  "&operp;": { "codepoints": [10681], "characters": "\u29B9" },
  "&oplus;": { "codepoints": [8853], "characters": "\u2295" },
  "&orarr;": { "codepoints": [8635], "characters": "\u21BB" },
  "&Or;": { "codepoints": [10836], "characters": "\u2A54" },
  "&or;": { "codepoints": [8744], "characters": "\u2228" },
  "&ord;": { "codepoints": [10845], "characters": "\u2A5D" },
  "&order;": { "codepoints": [8500], "characters": "\u2134" },
  "&orderof;": { "codepoints": [8500], "characters": "\u2134" },
  "&ordf;": { "codepoints": [170], "characters": "\u00AA" },
  "&ordf": { "codepoints": [170], "characters": "\u00AA" },
  "&ordm;": { "codepoints": [186], "characters": "\u00BA" },
  "&ordm": { "codepoints": [186], "characters": "\u00BA" },
  "&origof;": { "codepoints": [8886], "characters": "\u22B6" },
  "&oror;": { "codepoints": [10838], "characters": "\u2A56" },
  "&orslope;": { "codepoints": [10839], "characters": "\u2A57" },
  "&orv;": { "codepoints": [10843], "characters": "\u2A5B" },
  "&oS;": { "codepoints": [9416], "characters": "\u24C8" },
  "&Oscr;": { "codepoints": [119978], "characters": "\uD835\uDCAA" },
  "&oscr;": { "codepoints": [8500], "characters": "\u2134" },
  "&Oslash;": { "codepoints": [216], "characters": "\u00D8" },
  "&Oslash": { "codepoints": [216], "characters": "\u00D8" },
  "&oslash;": { "codepoints": [248], "characters": "\u00F8" },
  "&oslash": { "codepoints": [248], "characters": "\u00F8" },
  "&osol;": { "codepoints": [8856], "characters": "\u2298" },
  "&Otilde;": { "codepoints": [213], "characters": "\u00D5" },
  "&Otilde": { "codepoints": [213], "characters": "\u00D5" },
  "&otilde;": { "codepoints": [245], "characters": "\u00F5" },
  "&otilde": { "codepoints": [245], "characters": "\u00F5" },
  "&otimesas;": { "codepoints": [10806], "characters": "\u2A36" },
  "&Otimes;": { "codepoints": [10807], "characters": "\u2A37" },
  "&otimes;": { "codepoints": [8855], "characters": "\u2297" },
  "&Ouml;": { "codepoints": [214], "characters": "\u00D6" },
  "&Ouml": { "codepoints": [214], "characters": "\u00D6" },
  "&ouml;": { "codepoints": [246], "characters": "\u00F6" },
  "&ouml": { "codepoints": [246], "characters": "\u00F6" },
  "&ovbar;": { "codepoints": [9021], "characters": "\u233D" },
  "&OverBar;": { "codepoints": [8254], "characters": "\u203E" },
  "&OverBrace;": { "codepoints": [9182], "characters": "\u23DE" },
  "&OverBracket;": { "codepoints": [9140], "characters": "\u23B4" },
  "&OverParenthesis;": { "codepoints": [9180], "characters": "\u23DC" },
  "&para;": { "codepoints": [182], "characters": "\u00B6" },
  "&para": { "codepoints": [182], "characters": "\u00B6" },
  "&parallel;": { "codepoints": [8741], "characters": "\u2225" },
  "&par;": { "codepoints": [8741], "characters": "\u2225" },
  "&parsim;": { "codepoints": [10995], "characters": "\u2AF3" },
  "&parsl;": { "codepoints": [11005], "characters": "\u2AFD" },
  "&part;": { "codepoints": [8706], "characters": "\u2202" },
  "&PartialD;": { "codepoints": [8706], "characters": "\u2202" },
  "&Pcy;": { "codepoints": [1055], "characters": "\u041F" },
  "&pcy;": { "codepoints": [1087], "characters": "\u043F" },
  "&percnt;": { "codepoints": [37], "characters": "\u0025" },
  "&period;": { "codepoints": [46], "characters": "\u002E" },
  "&permil;": { "codepoints": [8240], "characters": "\u2030" },
  "&perp;": { "codepoints": [8869], "characters": "\u22A5" },
  "&pertenk;": { "codepoints": [8241], "characters": "\u2031" },
  "&Pfr;": { "codepoints": [120083], "characters": "\uD835\uDD13" },
  "&pfr;": { "codepoints": [120109], "characters": "\uD835\uDD2D" },
  "&Phi;": { "codepoints": [934], "characters": "\u03A6" },
  "&phi;": { "codepoints": [966], "characters": "\u03C6" },
  "&phiv;": { "codepoints": [981], "characters": "\u03D5" },
  "&phmmat;": { "codepoints": [8499], "characters": "\u2133" },
  "&phone;": { "codepoints": [9742], "characters": "\u260E" },
  "&Pi;": { "codepoints": [928], "characters": "\u03A0" },
  "&pi;": { "codepoints": [960], "characters": "\u03C0" },
  "&pitchfork;": { "codepoints": [8916], "characters": "\u22D4" },
  "&piv;": { "codepoints": [982], "characters": "\u03D6" },
  "&planck;": { "codepoints": [8463], "characters": "\u210F" },
  "&planckh;": { "codepoints": [8462], "characters": "\u210E" },
  "&plankv;": { "codepoints": [8463], "characters": "\u210F" },
  "&plusacir;": { "codepoints": [10787], "characters": "\u2A23" },
  "&plusb;": { "codepoints": [8862], "characters": "\u229E" },
  "&pluscir;": { "codepoints": [10786], "characters": "\u2A22" },
  "&plus;": { "codepoints": [43], "characters": "\u002B" },
  "&plusdo;": { "codepoints": [8724], "characters": "\u2214" },
  "&plusdu;": { "codepoints": [10789], "characters": "\u2A25" },
  "&pluse;": { "codepoints": [10866], "characters": "\u2A72" },
  "&PlusMinus;": { "codepoints": [177], "characters": "\u00B1" },
  "&plusmn;": { "codepoints": [177], "characters": "\u00B1" },
  "&plusmn": { "codepoints": [177], "characters": "\u00B1" },
  "&plussim;": { "codepoints": [10790], "characters": "\u2A26" },
  "&plustwo;": { "codepoints": [10791], "characters": "\u2A27" },
  "&pm;": { "codepoints": [177], "characters": "\u00B1" },
  "&Poincareplane;": { "codepoints": [8460], "characters": "\u210C" },
  "&pointint;": { "codepoints": [10773], "characters": "\u2A15" },
  "&popf;": { "codepoints": [120161], "characters": "\uD835\uDD61" },
  "&Popf;": { "codepoints": [8473], "characters": "\u2119" },
  "&pound;": { "codepoints": [163], "characters": "\u00A3" },
  "&pound": { "codepoints": [163], "characters": "\u00A3" },
  "&prap;": { "codepoints": [10935], "characters": "\u2AB7" },
  "&Pr;": { "codepoints": [10939], "characters": "\u2ABB" },
  "&pr;": { "codepoints": [8826], "characters": "\u227A" },
  "&prcue;": { "codepoints": [8828], "characters": "\u227C" },
  "&precapprox;": { "codepoints": [10935], "characters": "\u2AB7" },
  "&prec;": { "codepoints": [8826], "characters": "\u227A" },
  "&preccurlyeq;": { "codepoints": [8828], "characters": "\u227C" },
  "&Precedes;": { "codepoints": [8826], "characters": "\u227A" },
  "&PrecedesEqual;": { "codepoints": [10927], "characters": "\u2AAF" },
  "&PrecedesSlantEqual;": { "codepoints": [8828], "characters": "\u227C" },
  "&PrecedesTilde;": { "codepoints": [8830], "characters": "\u227E" },
  "&preceq;": { "codepoints": [10927], "characters": "\u2AAF" },
  "&precnapprox;": { "codepoints": [10937], "characters": "\u2AB9" },
  "&precneqq;": { "codepoints": [10933], "characters": "\u2AB5" },
  "&precnsim;": { "codepoints": [8936], "characters": "\u22E8" },
  "&pre;": { "codepoints": [10927], "characters": "\u2AAF" },
  "&prE;": { "codepoints": [10931], "characters": "\u2AB3" },
  "&precsim;": { "codepoints": [8830], "characters": "\u227E" },
  "&prime;": { "codepoints": [8242], "characters": "\u2032" },
  "&Prime;": { "codepoints": [8243], "characters": "\u2033" },
  "&primes;": { "codepoints": [8473], "characters": "\u2119" },
  "&prnap;": { "codepoints": [10937], "characters": "\u2AB9" },
  "&prnE;": { "codepoints": [10933], "characters": "\u2AB5" },
  "&prnsim;": { "codepoints": [8936], "characters": "\u22E8" },
  "&prod;": { "codepoints": [8719], "characters": "\u220F" },
  "&Product;": { "codepoints": [8719], "characters": "\u220F" },
  "&profalar;": { "codepoints": [9006], "characters": "\u232E" },
  "&profline;": { "codepoints": [8978], "characters": "\u2312" },
  "&profsurf;": { "codepoints": [8979], "characters": "\u2313" },
  "&prop;": { "codepoints": [8733], "characters": "\u221D" },
  "&Proportional;": { "codepoints": [8733], "characters": "\u221D" },
  "&Proportion;": { "codepoints": [8759], "characters": "\u2237" },
  "&propto;": { "codepoints": [8733], "characters": "\u221D" },
  "&prsim;": { "codepoints": [8830], "characters": "\u227E" },
  "&prurel;": { "codepoints": [8880], "characters": "\u22B0" },
  "&Pscr;": { "codepoints": [119979], "characters": "\uD835\uDCAB" },
  "&pscr;": { "codepoints": [120005], "characters": "\uD835\uDCC5" },
  "&Psi;": { "codepoints": [936], "characters": "\u03A8" },
  "&psi;": { "codepoints": [968], "characters": "\u03C8" },
  "&puncsp;": { "codepoints": [8200], "characters": "\u2008" },
  "&Qfr;": { "codepoints": [120084], "characters": "\uD835\uDD14" },
  "&qfr;": { "codepoints": [120110], "characters": "\uD835\uDD2E" },
  "&qint;": { "codepoints": [10764], "characters": "\u2A0C" },
  "&qopf;": { "codepoints": [120162], "characters": "\uD835\uDD62" },
  "&Qopf;": { "codepoints": [8474], "characters": "\u211A" },
  "&qprime;": { "codepoints": [8279], "characters": "\u2057" },
  "&Qscr;": { "codepoints": [119980], "characters": "\uD835\uDCAC" },
  "&qscr;": { "codepoints": [120006], "characters": "\uD835\uDCC6" },
  "&quaternions;": { "codepoints": [8461], "characters": "\u210D" },
  "&quatint;": { "codepoints": [10774], "characters": "\u2A16" },
  "&quest;": { "codepoints": [63], "characters": "\u003F" },
  "&questeq;": { "codepoints": [8799], "characters": "\u225F" },
  "&quot;": { "codepoints": [34], "characters": "\u0022" },
  "&quot": { "codepoints": [34], "characters": "\u0022" },
  "&QUOT;": { "codepoints": [34], "characters": "\u0022" },
  "&QUOT": { "codepoints": [34], "characters": "\u0022" },
  "&rAarr;": { "codepoints": [8667], "characters": "\u21DB" },
  "&race;": { "codepoints": [8765, 817], "characters": "\u223D\u0331" },
  "&Racute;": { "codepoints": [340], "characters": "\u0154" },
  "&racute;": { "codepoints": [341], "characters": "\u0155" },
  "&radic;": { "codepoints": [8730], "characters": "\u221A" },
  "&raemptyv;": { "codepoints": [10675], "characters": "\u29B3" },
  "&rang;": { "codepoints": [10217], "characters": "\u27E9" },
  "&Rang;": { "codepoints": [10219], "characters": "\u27EB" },
  "&rangd;": { "codepoints": [10642], "characters": "\u2992" },
  "&range;": { "codepoints": [10661], "characters": "\u29A5" },
  "&rangle;": { "codepoints": [10217], "characters": "\u27E9" },
  "&raquo;": { "codepoints": [187], "characters": "\u00BB" },
  "&raquo": { "codepoints": [187], "characters": "\u00BB" },
  "&rarrap;": { "codepoints": [10613], "characters": "\u2975" },
  "&rarrb;": { "codepoints": [8677], "characters": "\u21E5" },
  "&rarrbfs;": { "codepoints": [10528], "characters": "\u2920" },
  "&rarrc;": { "codepoints": [10547], "characters": "\u2933" },
  "&rarr;": { "codepoints": [8594], "characters": "\u2192" },
  "&Rarr;": { "codepoints": [8608], "characters": "\u21A0" },
  "&rArr;": { "codepoints": [8658], "characters": "\u21D2" },
  "&rarrfs;": { "codepoints": [10526], "characters": "\u291E" },
  "&rarrhk;": { "codepoints": [8618], "characters": "\u21AA" },
  "&rarrlp;": { "codepoints": [8620], "characters": "\u21AC" },
  "&rarrpl;": { "codepoints": [10565], "characters": "\u2945" },
  "&rarrsim;": { "codepoints": [10612], "characters": "\u2974" },
  "&Rarrtl;": { "codepoints": [10518], "characters": "\u2916" },
  "&rarrtl;": { "codepoints": [8611], "characters": "\u21A3" },
  "&rarrw;": { "codepoints": [8605], "characters": "\u219D" },
  "&ratail;": { "codepoints": [10522], "characters": "\u291A" },
  "&rAtail;": { "codepoints": [10524], "characters": "\u291C" },
  "&ratio;": { "codepoints": [8758], "characters": "\u2236" },
  "&rationals;": { "codepoints": [8474], "characters": "\u211A" },
  "&rbarr;": { "codepoints": [10509], "characters": "\u290D" },
  "&rBarr;": { "codepoints": [10511], "characters": "\u290F" },
  "&RBarr;": { "codepoints": [10512], "characters": "\u2910" },
  "&rbbrk;": { "codepoints": [10099], "characters": "\u2773" },
  "&rbrace;": { "codepoints": [125], "characters": "\u007D" },
  "&rbrack;": { "codepoints": [93], "characters": "\u005D" },
  "&rbrke;": { "codepoints": [10636], "characters": "\u298C" },
  "&rbrksld;": { "codepoints": [10638], "characters": "\u298E" },
  "&rbrkslu;": { "codepoints": [10640], "characters": "\u2990" },
  "&Rcaron;": { "codepoints": [344], "characters": "\u0158" },
  "&rcaron;": { "codepoints": [345], "characters": "\u0159" },
  "&Rcedil;": { "codepoints": [342], "characters": "\u0156" },
  "&rcedil;": { "codepoints": [343], "characters": "\u0157" },
  "&rceil;": { "codepoints": [8969], "characters": "\u2309" },
  "&rcub;": { "codepoints": [125], "characters": "\u007D" },
  "&Rcy;": { "codepoints": [1056], "characters": "\u0420" },
  "&rcy;": { "codepoints": [1088], "characters": "\u0440" },
  "&rdca;": { "codepoints": [10551], "characters": "\u2937" },
  "&rdldhar;": { "codepoints": [10601], "characters": "\u2969" },
  "&rdquo;": { "codepoints": [8221], "characters": "\u201D" },
  "&rdquor;": { "codepoints": [8221], "characters": "\u201D" },
  "&rdsh;": { "codepoints": [8627], "characters": "\u21B3" },
  "&real;": { "codepoints": [8476], "characters": "\u211C" },
  "&realine;": { "codepoints": [8475], "characters": "\u211B" },
  "&realpart;": { "codepoints": [8476], "characters": "\u211C" },
  "&reals;": { "codepoints": [8477], "characters": "\u211D" },
  "&Re;": { "codepoints": [8476], "characters": "\u211C" },
  "&rect;": { "codepoints": [9645], "characters": "\u25AD" },
  "&reg;": { "codepoints": [174], "characters": "\u00AE" },
  "&reg": { "codepoints": [174], "characters": "\u00AE" },
  "&REG;": { "codepoints": [174], "characters": "\u00AE" },
  "&REG": { "codepoints": [174], "characters": "\u00AE" },
  "&ReverseElement;": { "codepoints": [8715], "characters": "\u220B" },
  "&ReverseEquilibrium;": { "codepoints": [8651], "characters": "\u21CB" },
  "&ReverseUpEquilibrium;": { "codepoints": [10607], "characters": "\u296F" },
  "&rfisht;": { "codepoints": [10621], "characters": "\u297D" },
  "&rfloor;": { "codepoints": [8971], "characters": "\u230B" },
  "&rfr;": { "codepoints": [120111], "characters": "\uD835\uDD2F" },
  "&Rfr;": { "codepoints": [8476], "characters": "\u211C" },
  "&rHar;": { "codepoints": [10596], "characters": "\u2964" },
  "&rhard;": { "codepoints": [8641], "characters": "\u21C1" },
  "&rharu;": { "codepoints": [8640], "characters": "\u21C0" },
  "&rharul;": { "codepoints": [10604], "characters": "\u296C" },
  "&Rho;": { "codepoints": [929], "characters": "\u03A1" },
  "&rho;": { "codepoints": [961], "characters": "\u03C1" },
  "&rhov;": { "codepoints": [1009], "characters": "\u03F1" },
  "&RightAngleBracket;": { "codepoints": [10217], "characters": "\u27E9" },
  "&RightArrowBar;": { "codepoints": [8677], "characters": "\u21E5" },
  "&rightarrow;": { "codepoints": [8594], "characters": "\u2192" },
  "&RightArrow;": { "codepoints": [8594], "characters": "\u2192" },
  "&Rightarrow;": { "codepoints": [8658], "characters": "\u21D2" },
  "&RightArrowLeftArrow;": { "codepoints": [8644], "characters": "\u21C4" },
  "&rightarrowtail;": { "codepoints": [8611], "characters": "\u21A3" },
  "&RightCeiling;": { "codepoints": [8969], "characters": "\u2309" },
  "&RightDoubleBracket;": { "codepoints": [10215], "characters": "\u27E7" },
  "&RightDownTeeVector;": { "codepoints": [10589], "characters": "\u295D" },
  "&RightDownVectorBar;": { "codepoints": [10581], "characters": "\u2955" },
  "&RightDownVector;": { "codepoints": [8642], "characters": "\u21C2" },
  "&RightFloor;": { "codepoints": [8971], "characters": "\u230B" },
  "&rightharpoondown;": { "codepoints": [8641], "characters": "\u21C1" },
  "&rightharpoonup;": { "codepoints": [8640], "characters": "\u21C0" },
  "&rightleftarrows;": { "codepoints": [8644], "characters": "\u21C4" },
  "&rightleftharpoons;": { "codepoints": [8652], "characters": "\u21CC" },
  "&rightrightarrows;": { "codepoints": [8649], "characters": "\u21C9" },
  "&rightsquigarrow;": { "codepoints": [8605], "characters": "\u219D" },
  "&RightTeeArrow;": { "codepoints": [8614], "characters": "\u21A6" },
  "&RightTee;": { "codepoints": [8866], "characters": "\u22A2" },
  "&RightTeeVector;": { "codepoints": [10587], "characters": "\u295B" },
  "&rightthreetimes;": { "codepoints": [8908], "characters": "\u22CC" },
  "&RightTriangleBar;": { "codepoints": [10704], "characters": "\u29D0" },
  "&RightTriangle;": { "codepoints": [8883], "characters": "\u22B3" },
  "&RightTriangleEqual;": { "codepoints": [8885], "characters": "\u22B5" },
  "&RightUpDownVector;": { "codepoints": [10575], "characters": "\u294F" },
  "&RightUpTeeVector;": { "codepoints": [10588], "characters": "\u295C" },
  "&RightUpVectorBar;": { "codepoints": [10580], "characters": "\u2954" },
  "&RightUpVector;": { "codepoints": [8638], "characters": "\u21BE" },
  "&RightVectorBar;": { "codepoints": [10579], "characters": "\u2953" },
  "&RightVector;": { "codepoints": [8640], "characters": "\u21C0" },
  "&ring;": { "codepoints": [730], "characters": "\u02DA" },
  "&risingdotseq;": { "codepoints": [8787], "characters": "\u2253" },
  "&rlarr;": { "codepoints": [8644], "characters": "\u21C4" },
  "&rlhar;": { "codepoints": [8652], "characters": "\u21CC" },
  "&rlm;": { "codepoints": [8207], "characters": "\u200F" },
  "&rmoustache;": { "codepoints": [9137], "characters": "\u23B1" },
  "&rmoust;": { "codepoints": [9137], "characters": "\u23B1" },
  "&rnmid;": { "codepoints": [10990], "characters": "\u2AEE" },
  "&roang;": { "codepoints": [10221], "characters": "\u27ED" },
  "&roarr;": { "codepoints": [8702], "characters": "\u21FE" },
  "&robrk;": { "codepoints": [10215], "characters": "\u27E7" },
  "&ropar;": { "codepoints": [10630], "characters": "\u2986" },
  "&ropf;": { "codepoints": [120163], "characters": "\uD835\uDD63" },
  "&Ropf;": { "codepoints": [8477], "characters": "\u211D" },
  "&roplus;": { "codepoints": [10798], "characters": "\u2A2E" },
  "&rotimes;": { "codepoints": [10805], "characters": "\u2A35" },
  "&RoundImplies;": { "codepoints": [10608], "characters": "\u2970" },
  "&rpar;": { "codepoints": [41], "characters": "\u0029" },
  "&rpargt;": { "codepoints": [10644], "characters": "\u2994" },
  "&rppolint;": { "codepoints": [10770], "characters": "\u2A12" },
  "&rrarr;": { "codepoints": [8649], "characters": "\u21C9" },
  "&Rrightarrow;": { "codepoints": [8667], "characters": "\u21DB" },
  "&rsaquo;": { "codepoints": [8250], "characters": "\u203A" },
  "&rscr;": { "codepoints": [120007], "characters": "\uD835\uDCC7" },
  "&Rscr;": { "codepoints": [8475], "characters": "\u211B" },
  "&rsh;": { "codepoints": [8625], "characters": "\u21B1" },
  "&Rsh;": { "codepoints": [8625], "characters": "\u21B1" },
  "&rsqb;": { "codepoints": [93], "characters": "\u005D" },
  "&rsquo;": { "codepoints": [8217], "characters": "\u2019" },
  "&rsquor;": { "codepoints": [8217], "characters": "\u2019" },
  "&rthree;": { "codepoints": [8908], "characters": "\u22CC" },
  "&rtimes;": { "codepoints": [8906], "characters": "\u22CA" },
  "&rtri;": { "codepoints": [9657], "characters": "\u25B9" },
  "&rtrie;": { "codepoints": [8885], "characters": "\u22B5" },
  "&rtrif;": { "codepoints": [9656], "characters": "\u25B8" },
  "&rtriltri;": { "codepoints": [10702], "characters": "\u29CE" },
  "&RuleDelayed;": { "codepoints": [10740], "characters": "\u29F4" },
  "&ruluhar;": { "codepoints": [10600], "characters": "\u2968" },
  "&rx;": { "codepoints": [8478], "characters": "\u211E" },
  "&Sacute;": { "codepoints": [346], "characters": "\u015A" },
  "&sacute;": { "codepoints": [347], "characters": "\u015B" },
  "&sbquo;": { "codepoints": [8218], "characters": "\u201A" },
  "&scap;": { "codepoints": [10936], "characters": "\u2AB8" },
  "&Scaron;": { "codepoints": [352], "characters": "\u0160" },
  "&scaron;": { "codepoints": [353], "characters": "\u0161" },
  "&Sc;": { "codepoints": [10940], "characters": "\u2ABC" },
  "&sc;": { "codepoints": [8827], "characters": "\u227B" },
  "&sccue;": { "codepoints": [8829], "characters": "\u227D" },
  "&sce;": { "codepoints": [10928], "characters": "\u2AB0" },
  "&scE;": { "codepoints": [10932], "characters": "\u2AB4" },
  "&Scedil;": { "codepoints": [350], "characters": "\u015E" },
  "&scedil;": { "codepoints": [351], "characters": "\u015F" },
  "&Scirc;": { "codepoints": [348], "characters": "\u015C" },
  "&scirc;": { "codepoints": [349], "characters": "\u015D" },
  "&scnap;": { "codepoints": [10938], "characters": "\u2ABA" },
  "&scnE;": { "codepoints": [10934], "characters": "\u2AB6" },
  "&scnsim;": { "codepoints": [8937], "characters": "\u22E9" },
  "&scpolint;": { "codepoints": [10771], "characters": "\u2A13" },
  "&scsim;": { "codepoints": [8831], "characters": "\u227F" },
  "&Scy;": { "codepoints": [1057], "characters": "\u0421" },
  "&scy;": { "codepoints": [1089], "characters": "\u0441" },
  "&sdotb;": { "codepoints": [8865], "characters": "\u22A1" },
  "&sdot;": { "codepoints": [8901], "characters": "\u22C5" },
  "&sdote;": { "codepoints": [10854], "characters": "\u2A66" },
  "&searhk;": { "codepoints": [10533], "characters": "\u2925" },
  "&searr;": { "codepoints": [8600], "characters": "\u2198" },
  "&seArr;": { "codepoints": [8664], "characters": "\u21D8" },
  "&searrow;": { "codepoints": [8600], "characters": "\u2198" },
  "&sect;": { "codepoints": [167], "characters": "\u00A7" },
  "&sect": { "codepoints": [167], "characters": "\u00A7" },
  "&semi;": { "codepoints": [59], "characters": "\u003B" },
  "&seswar;": { "codepoints": [10537], "characters": "\u2929" },
  "&setminus;": { "codepoints": [8726], "characters": "\u2216" },
  "&setmn;": { "codepoints": [8726], "characters": "\u2216" },
  "&sext;": { "codepoints": [10038], "characters": "\u2736" },
  "&Sfr;": { "codepoints": [120086], "characters": "\uD835\uDD16" },
  "&sfr;": { "codepoints": [120112], "characters": "\uD835\uDD30" },
  "&sfrown;": { "codepoints": [8994], "characters": "\u2322" },
  "&sharp;": { "codepoints": [9839], "characters": "\u266F" },
  "&SHCHcy;": { "codepoints": [1065], "characters": "\u0429" },
  "&shchcy;": { "codepoints": [1097], "characters": "\u0449" },
  "&SHcy;": { "codepoints": [1064], "characters": "\u0428" },
  "&shcy;": { "codepoints": [1096], "characters": "\u0448" },
  "&ShortDownArrow;": { "codepoints": [8595], "characters": "\u2193" },
  "&ShortLeftArrow;": { "codepoints": [8592], "characters": "\u2190" },
  "&shortmid;": { "codepoints": [8739], "characters": "\u2223" },
  "&shortparallel;": { "codepoints": [8741], "characters": "\u2225" },
  "&ShortRightArrow;": { "codepoints": [8594], "characters": "\u2192" },
  "&ShortUpArrow;": { "codepoints": [8593], "characters": "\u2191" },
  "&shy;": { "codepoints": [173], "characters": "\u00AD" },
  "&shy": { "codepoints": [173], "characters": "\u00AD" },
  "&Sigma;": { "codepoints": [931], "characters": "\u03A3" },
  "&sigma;": { "codepoints": [963], "characters": "\u03C3" },
  "&sigmaf;": { "codepoints": [962], "characters": "\u03C2" },
  "&sigmav;": { "codepoints": [962], "characters": "\u03C2" },
  "&sim;": { "codepoints": [8764], "characters": "\u223C" },
  "&simdot;": { "codepoints": [10858], "characters": "\u2A6A" },
  "&sime;": { "codepoints": [8771], "characters": "\u2243" },
  "&simeq;": { "codepoints": [8771], "characters": "\u2243" },
  "&simg;": { "codepoints": [10910], "characters": "\u2A9E" },
  "&simgE;": { "codepoints": [10912], "characters": "\u2AA0" },
  "&siml;": { "codepoints": [10909], "characters": "\u2A9D" },
  "&simlE;": { "codepoints": [10911], "characters": "\u2A9F" },
  "&simne;": { "codepoints": [8774], "characters": "\u2246" },
  "&simplus;": { "codepoints": [10788], "characters": "\u2A24" },
  "&simrarr;": { "codepoints": [10610], "characters": "\u2972" },
  "&slarr;": { "codepoints": [8592], "characters": "\u2190" },
  "&SmallCircle;": { "codepoints": [8728], "characters": "\u2218" },
  "&smallsetminus;": { "codepoints": [8726], "characters": "\u2216" },
  "&smashp;": { "codepoints": [10803], "characters": "\u2A33" },
  "&smeparsl;": { "codepoints": [10724], "characters": "\u29E4" },
  "&smid;": { "codepoints": [8739], "characters": "\u2223" },
  "&smile;": { "codepoints": [8995], "characters": "\u2323" },
  "&smt;": { "codepoints": [10922], "characters": "\u2AAA" },
  "&smte;": { "codepoints": [10924], "characters": "\u2AAC" },
  "&smtes;": { "codepoints": [10924, 65024], "characters": "\u2AAC\uFE00" },
  "&SOFTcy;": { "codepoints": [1068], "characters": "\u042C" },
  "&softcy;": { "codepoints": [1100], "characters": "\u044C" },
  "&solbar;": { "codepoints": [9023], "characters": "\u233F" },
  "&solb;": { "codepoints": [10692], "characters": "\u29C4" },
  "&sol;": { "codepoints": [47], "characters": "\u002F" },
  "&Sopf;": { "codepoints": [120138], "characters": "\uD835\uDD4A" },
  "&sopf;": { "codepoints": [120164], "characters": "\uD835\uDD64" },
  "&spades;": { "codepoints": [9824], "characters": "\u2660" },
  "&spadesuit;": { "codepoints": [9824], "characters": "\u2660" },
  "&spar;": { "codepoints": [8741], "characters": "\u2225" },
  "&sqcap;": { "codepoints": [8851], "characters": "\u2293" },
  "&sqcaps;": { "codepoints": [8851, 65024], "characters": "\u2293\uFE00" },
  "&sqcup;": { "codepoints": [8852], "characters": "\u2294" },
  "&sqcups;": { "codepoints": [8852, 65024], "characters": "\u2294\uFE00" },
  "&Sqrt;": { "codepoints": [8730], "characters": "\u221A" },
  "&sqsub;": { "codepoints": [8847], "characters": "\u228F" },
  "&sqsube;": { "codepoints": [8849], "characters": "\u2291" },
  "&sqsubset;": { "codepoints": [8847], "characters": "\u228F" },
  "&sqsubseteq;": { "codepoints": [8849], "characters": "\u2291" },
  "&sqsup;": { "codepoints": [8848], "characters": "\u2290" },
  "&sqsupe;": { "codepoints": [8850], "characters": "\u2292" },
  "&sqsupset;": { "codepoints": [8848], "characters": "\u2290" },
  "&sqsupseteq;": { "codepoints": [8850], "characters": "\u2292" },
  "&square;": { "codepoints": [9633], "characters": "\u25A1" },
  "&Square;": { "codepoints": [9633], "characters": "\u25A1" },
  "&SquareIntersection;": { "codepoints": [8851], "characters": "\u2293" },
  "&SquareSubset;": { "codepoints": [8847], "characters": "\u228F" },
  "&SquareSubsetEqual;": { "codepoints": [8849], "characters": "\u2291" },
  "&SquareSuperset;": { "codepoints": [8848], "characters": "\u2290" },
  "&SquareSupersetEqual;": { "codepoints": [8850], "characters": "\u2292" },
  "&SquareUnion;": { "codepoints": [8852], "characters": "\u2294" },
  "&squarf;": { "codepoints": [9642], "characters": "\u25AA" },
  "&squ;": { "codepoints": [9633], "characters": "\u25A1" },
  "&squf;": { "codepoints": [9642], "characters": "\u25AA" },
  "&srarr;": { "codepoints": [8594], "characters": "\u2192" },
  "&Sscr;": { "codepoints": [119982], "characters": "\uD835\uDCAE" },
  "&sscr;": { "codepoints": [120008], "characters": "\uD835\uDCC8" },
  "&ssetmn;": { "codepoints": [8726], "characters": "\u2216" },
  "&ssmile;": { "codepoints": [8995], "characters": "\u2323" },
  "&sstarf;": { "codepoints": [8902], "characters": "\u22C6" },
  "&Star;": { "codepoints": [8902], "characters": "\u22C6" },
  "&star;": { "codepoints": [9734], "characters": "\u2606" },
  "&starf;": { "codepoints": [9733], "characters": "\u2605" },
  "&straightepsilon;": { "codepoints": [1013], "characters": "\u03F5" },
  "&straightphi;": { "codepoints": [981], "characters": "\u03D5" },
  "&strns;": { "codepoints": [175], "characters": "\u00AF" },
  "&sub;": { "codepoints": [8834], "characters": "\u2282" },
  "&Sub;": { "codepoints": [8912], "characters": "\u22D0" },
  "&subdot;": { "codepoints": [10941], "characters": "\u2ABD" },
  "&subE;": { "codepoints": [10949], "characters": "\u2AC5" },
  "&sube;": { "codepoints": [8838], "characters": "\u2286" },
  "&subedot;": { "codepoints": [10947], "characters": "\u2AC3" },
  "&submult;": { "codepoints": [10945], "characters": "\u2AC1" },
  "&subnE;": { "codepoints": [10955], "characters": "\u2ACB" },
  "&subne;": { "codepoints": [8842], "characters": "\u228A" },
  "&subplus;": { "codepoints": [10943], "characters": "\u2ABF" },
  "&subrarr;": { "codepoints": [10617], "characters": "\u2979" },
  "&subset;": { "codepoints": [8834], "characters": "\u2282" },
  "&Subset;": { "codepoints": [8912], "characters": "\u22D0" },
  "&subseteq;": { "codepoints": [8838], "characters": "\u2286" },
  "&subseteqq;": { "codepoints": [10949], "characters": "\u2AC5" },
  "&SubsetEqual;": { "codepoints": [8838], "characters": "\u2286" },
  "&subsetneq;": { "codepoints": [8842], "characters": "\u228A" },
  "&subsetneqq;": { "codepoints": [10955], "characters": "\u2ACB" },
  "&subsim;": { "codepoints": [10951], "characters": "\u2AC7" },
  "&subsub;": { "codepoints": [10965], "characters": "\u2AD5" },
  "&subsup;": { "codepoints": [10963], "characters": "\u2AD3" },
  "&succapprox;": { "codepoints": [10936], "characters": "\u2AB8" },
  "&succ;": { "codepoints": [8827], "characters": "\u227B" },
  "&succcurlyeq;": { "codepoints": [8829], "characters": "\u227D" },
  "&Succeeds;": { "codepoints": [8827], "characters": "\u227B" },
  "&SucceedsEqual;": { "codepoints": [10928], "characters": "\u2AB0" },
  "&SucceedsSlantEqual;": { "codepoints": [8829], "characters": "\u227D" },
  "&SucceedsTilde;": { "codepoints": [8831], "characters": "\u227F" },
  "&succeq;": { "codepoints": [10928], "characters": "\u2AB0" },
  "&succnapprox;": { "codepoints": [10938], "characters": "\u2ABA" },
  "&succneqq;": { "codepoints": [10934], "characters": "\u2AB6" },
  "&succnsim;": { "codepoints": [8937], "characters": "\u22E9" },
  "&succsim;": { "codepoints": [8831], "characters": "\u227F" },
  "&SuchThat;": { "codepoints": [8715], "characters": "\u220B" },
  "&sum;": { "codepoints": [8721], "characters": "\u2211" },
  "&Sum;": { "codepoints": [8721], "characters": "\u2211" },
  "&sung;": { "codepoints": [9834], "characters": "\u266A" },
  "&sup1;": { "codepoints": [185], "characters": "\u00B9" },
  "&sup1": { "codepoints": [185], "characters": "\u00B9" },
  "&sup2;": { "codepoints": [178], "characters": "\u00B2" },
  "&sup2": { "codepoints": [178], "characters": "\u00B2" },
  "&sup3;": { "codepoints": [179], "characters": "\u00B3" },
  "&sup3": { "codepoints": [179], "characters": "\u00B3" },
  "&sup;": { "codepoints": [8835], "characters": "\u2283" },
  "&Sup;": { "codepoints": [8913], "characters": "\u22D1" },
  "&supdot;": { "codepoints": [10942], "characters": "\u2ABE" },
  "&supdsub;": { "codepoints": [10968], "characters": "\u2AD8" },
  "&supE;": { "codepoints": [10950], "characters": "\u2AC6" },
  "&supe;": { "codepoints": [8839], "characters": "\u2287" },
  "&supedot;": { "codepoints": [10948], "characters": "\u2AC4" },
  "&Superset;": { "codepoints": [8835], "characters": "\u2283" },
  "&SupersetEqual;": { "codepoints": [8839], "characters": "\u2287" },
  "&suphsol;": { "codepoints": [10185], "characters": "\u27C9" },
  "&suphsub;": { "codepoints": [10967], "characters": "\u2AD7" },
  "&suplarr;": { "codepoints": [10619], "characters": "\u297B" },
  "&supmult;": { "codepoints": [10946], "characters": "\u2AC2" },
  "&supnE;": { "codepoints": [10956], "characters": "\u2ACC" },
  "&supne;": { "codepoints": [8843], "characters": "\u228B" },
  "&supplus;": { "codepoints": [10944], "characters": "\u2AC0" },
  "&supset;": { "codepoints": [8835], "characters": "\u2283" },
  "&Supset;": { "codepoints": [8913], "characters": "\u22D1" },
  "&supseteq;": { "codepoints": [8839], "characters": "\u2287" },
  "&supseteqq;": { "codepoints": [10950], "characters": "\u2AC6" },
  "&supsetneq;": { "codepoints": [8843], "characters": "\u228B" },
  "&supsetneqq;": { "codepoints": [10956], "characters": "\u2ACC" },
  "&supsim;": { "codepoints": [10952], "characters": "\u2AC8" },
  "&supsub;": { "codepoints": [10964], "characters": "\u2AD4" },
  "&supsup;": { "codepoints": [10966], "characters": "\u2AD6" },
  "&swarhk;": { "codepoints": [10534], "characters": "\u2926" },
  "&swarr;": { "codepoints": [8601], "characters": "\u2199" },
  "&swArr;": { "codepoints": [8665], "characters": "\u21D9" },
  "&swarrow;": { "codepoints": [8601], "characters": "\u2199" },
  "&swnwar;": { "codepoints": [10538], "characters": "\u292A" },
  "&szlig;": { "codepoints": [223], "characters": "\u00DF" },
  "&szlig": { "codepoints": [223], "characters": "\u00DF" },
  "&Tab;": { "codepoints": [9], "characters": "\u0009" },
  "&target;": { "codepoints": [8982], "characters": "\u2316" },
  "&Tau;": { "codepoints": [932], "characters": "\u03A4" },
  "&tau;": { "codepoints": [964], "characters": "\u03C4" },
  "&tbrk;": { "codepoints": [9140], "characters": "\u23B4" },
  "&Tcaron;": { "codepoints": [356], "characters": "\u0164" },
  "&tcaron;": { "codepoints": [357], "characters": "\u0165" },
  "&Tcedil;": { "codepoints": [354], "characters": "\u0162" },
  "&tcedil;": { "codepoints": [355], "characters": "\u0163" },
  "&Tcy;": { "codepoints": [1058], "characters": "\u0422" },
  "&tcy;": { "codepoints": [1090], "characters": "\u0442" },
  "&tdot;": { "codepoints": [8411], "characters": "\u20DB" },
  "&telrec;": { "codepoints": [8981], "characters": "\u2315" },
  "&Tfr;": { "codepoints": [120087], "characters": "\uD835\uDD17" },
  "&tfr;": { "codepoints": [120113], "characters": "\uD835\uDD31" },
  "&there4;": { "codepoints": [8756], "characters": "\u2234" },
  "&therefore;": { "codepoints": [8756], "characters": "\u2234" },
  "&Therefore;": { "codepoints": [8756], "characters": "\u2234" },
  "&Theta;": { "codepoints": [920], "characters": "\u0398" },
  "&theta;": { "codepoints": [952], "characters": "\u03B8" },
  "&thetasym;": { "codepoints": [977], "characters": "\u03D1" },
  "&thetav;": { "codepoints": [977], "characters": "\u03D1" },
  "&thickapprox;": { "codepoints": [8776], "characters": "\u2248" },
  "&thicksim;": { "codepoints": [8764], "characters": "\u223C" },
  "&ThickSpace;": { "codepoints": [8287, 8202], "characters": "\u205F\u200A" },
  "&ThinSpace;": { "codepoints": [8201], "characters": "\u2009" },
  "&thinsp;": { "codepoints": [8201], "characters": "\u2009" },
  "&thkap;": { "codepoints": [8776], "characters": "\u2248" },
  "&thksim;": { "codepoints": [8764], "characters": "\u223C" },
  "&THORN;": { "codepoints": [222], "characters": "\u00DE" },
  "&THORN": { "codepoints": [222], "characters": "\u00DE" },
  "&thorn;": { "codepoints": [254], "characters": "\u00FE" },
  "&thorn": { "codepoints": [254], "characters": "\u00FE" },
  "&tilde;": { "codepoints": [732], "characters": "\u02DC" },
  "&Tilde;": { "codepoints": [8764], "characters": "\u223C" },
  "&TildeEqual;": { "codepoints": [8771], "characters": "\u2243" },
  "&TildeFullEqual;": { "codepoints": [8773], "characters": "\u2245" },
  "&TildeTilde;": { "codepoints": [8776], "characters": "\u2248" },
  "&timesbar;": { "codepoints": [10801], "characters": "\u2A31" },
  "&timesb;": { "codepoints": [8864], "characters": "\u22A0" },
  "&times;": { "codepoints": [215], "characters": "\u00D7" },
  "&times": { "codepoints": [215], "characters": "\u00D7" },
  "&timesd;": { "codepoints": [10800], "characters": "\u2A30" },
  "&tint;": { "codepoints": [8749], "characters": "\u222D" },
  "&toea;": { "codepoints": [10536], "characters": "\u2928" },
  "&topbot;": { "codepoints": [9014], "characters": "\u2336" },
  "&topcir;": { "codepoints": [10993], "characters": "\u2AF1" },
  "&top;": { "codepoints": [8868], "characters": "\u22A4" },
  "&Topf;": { "codepoints": [120139], "characters": "\uD835\uDD4B" },
  "&topf;": { "codepoints": [120165], "characters": "\uD835\uDD65" },
  "&topfork;": { "codepoints": [10970], "characters": "\u2ADA" },
  "&tosa;": { "codepoints": [10537], "characters": "\u2929" },
  "&tprime;": { "codepoints": [8244], "characters": "\u2034" },
  "&trade;": { "codepoints": [8482], "characters": "\u2122" },
  "&TRADE;": { "codepoints": [8482], "characters": "\u2122" },
  "&triangle;": { "codepoints": [9653], "characters": "\u25B5" },
  "&triangledown;": { "codepoints": [9663], "characters": "\u25BF" },
  "&triangleleft;": { "codepoints": [9667], "characters": "\u25C3" },
  "&trianglelefteq;": { "codepoints": [8884], "characters": "\u22B4" },
  "&triangleq;": { "codepoints": [8796], "characters": "\u225C" },
  "&triangleright;": { "codepoints": [9657], "characters": "\u25B9" },
  "&trianglerighteq;": { "codepoints": [8885], "characters": "\u22B5" },
  "&tridot;": { "codepoints": [9708], "characters": "\u25EC" },
  "&trie;": { "codepoints": [8796], "characters": "\u225C" },
  "&triminus;": { "codepoints": [10810], "characters": "\u2A3A" },
  "&TripleDot;": { "codepoints": [8411], "characters": "\u20DB" },
  "&triplus;": { "codepoints": [10809], "characters": "\u2A39" },
  "&trisb;": { "codepoints": [10701], "characters": "\u29CD" },
  "&tritime;": { "codepoints": [10811], "characters": "\u2A3B" },
  "&trpezium;": { "codepoints": [9186], "characters": "\u23E2" },
  "&Tscr;": { "codepoints": [119983], "characters": "\uD835\uDCAF" },
  "&tscr;": { "codepoints": [120009], "characters": "\uD835\uDCC9" },
  "&TScy;": { "codepoints": [1062], "characters": "\u0426" },
  "&tscy;": { "codepoints": [1094], "characters": "\u0446" },
  "&TSHcy;": { "codepoints": [1035], "characters": "\u040B" },
  "&tshcy;": { "codepoints": [1115], "characters": "\u045B" },
  "&Tstrok;": { "codepoints": [358], "characters": "\u0166" },
  "&tstrok;": { "codepoints": [359], "characters": "\u0167" },
  "&twixt;": { "codepoints": [8812], "characters": "\u226C" },
  "&twoheadleftarrow;": { "codepoints": [8606], "characters": "\u219E" },
  "&twoheadrightarrow;": { "codepoints": [8608], "characters": "\u21A0" },
  "&Uacute;": { "codepoints": [218], "characters": "\u00DA" },
  "&Uacute": { "codepoints": [218], "characters": "\u00DA" },
  "&uacute;": { "codepoints": [250], "characters": "\u00FA" },
  "&uacute": { "codepoints": [250], "characters": "\u00FA" },
  "&uarr;": { "codepoints": [8593], "characters": "\u2191" },
  "&Uarr;": { "codepoints": [8607], "characters": "\u219F" },
  "&uArr;": { "codepoints": [8657], "characters": "\u21D1" },
  "&Uarrocir;": { "codepoints": [10569], "characters": "\u2949" },
  "&Ubrcy;": { "codepoints": [1038], "characters": "\u040E" },
  "&ubrcy;": { "codepoints": [1118], "characters": "\u045E" },
  "&Ubreve;": { "codepoints": [364], "characters": "\u016C" },
  "&ubreve;": { "codepoints": [365], "characters": "\u016D" },
  "&Ucirc;": { "codepoints": [219], "characters": "\u00DB" },
  "&Ucirc": { "codepoints": [219], "characters": "\u00DB" },
  "&ucirc;": { "codepoints": [251], "characters": "\u00FB" },
  "&ucirc": { "codepoints": [251], "characters": "\u00FB" },
  "&Ucy;": { "codepoints": [1059], "characters": "\u0423" },
  "&ucy;": { "codepoints": [1091], "characters": "\u0443" },
  "&udarr;": { "codepoints": [8645], "characters": "\u21C5" },
  "&Udblac;": { "codepoints": [368], "characters": "\u0170" },
  "&udblac;": { "codepoints": [369], "characters": "\u0171" },
  "&udhar;": { "codepoints": [10606], "characters": "\u296E" },
  "&ufisht;": { "codepoints": [10622], "characters": "\u297E" },
  "&Ufr;": { "codepoints": [120088], "characters": "\uD835\uDD18" },
  "&ufr;": { "codepoints": [120114], "characters": "\uD835\uDD32" },
  "&Ugrave;": { "codepoints": [217], "characters": "\u00D9" },
  "&Ugrave": { "codepoints": [217], "characters": "\u00D9" },
  "&ugrave;": { "codepoints": [249], "characters": "\u00F9" },
  "&ugrave": { "codepoints": [249], "characters": "\u00F9" },
  "&uHar;": { "codepoints": [10595], "characters": "\u2963" },
  "&uharl;": { "codepoints": [8639], "characters": "\u21BF" },
  "&uharr;": { "codepoints": [8638], "characters": "\u21BE" },
  "&uhblk;": { "codepoints": [9600], "characters": "\u2580" },
  "&ulcorn;": { "codepoints": [8988], "characters": "\u231C" },
  "&ulcorner;": { "codepoints": [8988], "characters": "\u231C" },
  "&ulcrop;": { "codepoints": [8975], "characters": "\u230F" },
  "&ultri;": { "codepoints": [9720], "characters": "\u25F8" },
  "&Umacr;": { "codepoints": [362], "characters": "\u016A" },
  "&umacr;": { "codepoints": [363], "characters": "\u016B" },
  "&uml;": { "codepoints": [168], "characters": "\u00A8" },
  "&uml": { "codepoints": [168], "characters": "\u00A8" },
  "&UnderBar;": { "codepoints": [95], "characters": "\u005F" },
  "&UnderBrace;": { "codepoints": [9183], "characters": "\u23DF" },
  "&UnderBracket;": { "codepoints": [9141], "characters": "\u23B5" },
  "&UnderParenthesis;": { "codepoints": [9181], "characters": "\u23DD" },
  "&Union;": { "codepoints": [8899], "characters": "\u22C3" },
  "&UnionPlus;": { "codepoints": [8846], "characters": "\u228E" },
  "&Uogon;": { "codepoints": [370], "characters": "\u0172" },
  "&uogon;": { "codepoints": [371], "characters": "\u0173" },
  "&Uopf;": { "codepoints": [120140], "characters": "\uD835\uDD4C" },
  "&uopf;": { "codepoints": [120166], "characters": "\uD835\uDD66" },
  "&UpArrowBar;": { "codepoints": [10514], "characters": "\u2912" },
  "&uparrow;": { "codepoints": [8593], "characters": "\u2191" },
  "&UpArrow;": { "codepoints": [8593], "characters": "\u2191" },
  "&Uparrow;": { "codepoints": [8657], "characters": "\u21D1" },
  "&UpArrowDownArrow;": { "codepoints": [8645], "characters": "\u21C5" },
  "&updownarrow;": { "codepoints": [8597], "characters": "\u2195" },
  "&UpDownArrow;": { "codepoints": [8597], "characters": "\u2195" },
  "&Updownarrow;": { "codepoints": [8661], "characters": "\u21D5" },
  "&UpEquilibrium;": { "codepoints": [10606], "characters": "\u296E" },
  "&upharpoonleft;": { "codepoints": [8639], "characters": "\u21BF" },
  "&upharpoonright;": { "codepoints": [8638], "characters": "\u21BE" },
  "&uplus;": { "codepoints": [8846], "characters": "\u228E" },
  "&UpperLeftArrow;": { "codepoints": [8598], "characters": "\u2196" },
  "&UpperRightArrow;": { "codepoints": [8599], "characters": "\u2197" },
  "&upsi;": { "codepoints": [965], "characters": "\u03C5" },
  "&Upsi;": { "codepoints": [978], "characters": "\u03D2" },
  "&upsih;": { "codepoints": [978], "characters": "\u03D2" },
  "&Upsilon;": { "codepoints": [933], "characters": "\u03A5" },
  "&upsilon;": { "codepoints": [965], "characters": "\u03C5" },
  "&UpTeeArrow;": { "codepoints": [8613], "characters": "\u21A5" },
  "&UpTee;": { "codepoints": [8869], "characters": "\u22A5" },
  "&upuparrows;": { "codepoints": [8648], "characters": "\u21C8" },
  "&urcorn;": { "codepoints": [8989], "characters": "\u231D" },
  "&urcorner;": { "codepoints": [8989], "characters": "\u231D" },
  "&urcrop;": { "codepoints": [8974], "characters": "\u230E" },
  "&Uring;": { "codepoints": [366], "characters": "\u016E" },
  "&uring;": { "codepoints": [367], "characters": "\u016F" },
  "&urtri;": { "codepoints": [9721], "characters": "\u25F9" },
  "&Uscr;": { "codepoints": [119984], "characters": "\uD835\uDCB0" },
  "&uscr;": { "codepoints": [120010], "characters": "\uD835\uDCCA" },
  "&utdot;": { "codepoints": [8944], "characters": "\u22F0" },
  "&Utilde;": { "codepoints": [360], "characters": "\u0168" },
  "&utilde;": { "codepoints": [361], "characters": "\u0169" },
  "&utri;": { "codepoints": [9653], "characters": "\u25B5" },
  "&utrif;": { "codepoints": [9652], "characters": "\u25B4" },
  "&uuarr;": { "codepoints": [8648], "characters": "\u21C8" },
  "&Uuml;": { "codepoints": [220], "characters": "\u00DC" },
  "&Uuml": { "codepoints": [220], "characters": "\u00DC" },
  "&uuml;": { "codepoints": [252], "characters": "\u00FC" },
  "&uuml": { "codepoints": [252], "characters": "\u00FC" },
  "&uwangle;": { "codepoints": [10663], "characters": "\u29A7" },
  "&vangrt;": { "codepoints": [10652], "characters": "\u299C" },
  "&varepsilon;": { "codepoints": [1013], "characters": "\u03F5" },
  "&varkappa;": { "codepoints": [1008], "characters": "\u03F0" },
  "&varnothing;": { "codepoints": [8709], "characters": "\u2205" },
  "&varphi;": { "codepoints": [981], "characters": "\u03D5" },
  "&varpi;": { "codepoints": [982], "characters": "\u03D6" },
  "&varpropto;": { "codepoints": [8733], "characters": "\u221D" },
  "&varr;": { "codepoints": [8597], "characters": "\u2195" },
  "&vArr;": { "codepoints": [8661], "characters": "\u21D5" },
  "&varrho;": { "codepoints": [1009], "characters": "\u03F1" },
  "&varsigma;": { "codepoints": [962], "characters": "\u03C2" },
  "&varsubsetneq;": { "codepoints": [8842, 65024], "characters": "\u228A\uFE00" },
  "&varsubsetneqq;": { "codepoints": [10955, 65024], "characters": "\u2ACB\uFE00" },
  "&varsupsetneq;": { "codepoints": [8843, 65024], "characters": "\u228B\uFE00" },
  "&varsupsetneqq;": { "codepoints": [10956, 65024], "characters": "\u2ACC\uFE00" },
  "&vartheta;": { "codepoints": [977], "characters": "\u03D1" },
  "&vartriangleleft;": { "codepoints": [8882], "characters": "\u22B2" },
  "&vartriangleright;": { "codepoints": [8883], "characters": "\u22B3" },
  "&vBar;": { "codepoints": [10984], "characters": "\u2AE8" },
  "&Vbar;": { "codepoints": [10987], "characters": "\u2AEB" },
  "&vBarv;": { "codepoints": [10985], "characters": "\u2AE9" },
  "&Vcy;": { "codepoints": [1042], "characters": "\u0412" },
  "&vcy;": { "codepoints": [1074], "characters": "\u0432" },
  "&vdash;": { "codepoints": [8866], "characters": "\u22A2" },
  "&vDash;": { "codepoints": [8872], "characters": "\u22A8" },
  "&Vdash;": { "codepoints": [8873], "characters": "\u22A9" },
  "&VDash;": { "codepoints": [8875], "characters": "\u22AB" },
  "&Vdashl;": { "codepoints": [10982], "characters": "\u2AE6" },
  "&veebar;": { "codepoints": [8891], "characters": "\u22BB" },
  "&vee;": { "codepoints": [8744], "characters": "\u2228" },
  "&Vee;": { "codepoints": [8897], "characters": "\u22C1" },
  "&veeeq;": { "codepoints": [8794], "characters": "\u225A" },
  "&vellip;": { "codepoints": [8942], "characters": "\u22EE" },
  "&verbar;": { "codepoints": [124], "characters": "\u007C" },
  "&Verbar;": { "codepoints": [8214], "characters": "\u2016" },
  "&vert;": { "codepoints": [124], "characters": "\u007C" },
  "&Vert;": { "codepoints": [8214], "characters": "\u2016" },
  "&VerticalBar;": { "codepoints": [8739], "characters": "\u2223" },
  "&VerticalLine;": { "codepoints": [124], "characters": "\u007C" },
  "&VerticalSeparator;": { "codepoints": [10072], "characters": "\u2758" },
  "&VerticalTilde;": { "codepoints": [8768], "characters": "\u2240" },
  "&VeryThinSpace;": { "codepoints": [8202], "characters": "\u200A" },
  "&Vfr;": { "codepoints": [120089], "characters": "\uD835\uDD19" },
  "&vfr;": { "codepoints": [120115], "characters": "\uD835\uDD33" },
  "&vltri;": { "codepoints": [8882], "characters": "\u22B2" },
  "&vnsub;": { "codepoints": [8834, 8402], "characters": "\u2282\u20D2" },
  "&vnsup;": { "codepoints": [8835, 8402], "characters": "\u2283\u20D2" },
  "&Vopf;": { "codepoints": [120141], "characters": "\uD835\uDD4D" },
  "&vopf;": { "codepoints": [120167], "characters": "\uD835\uDD67" },
  "&vprop;": { "codepoints": [8733], "characters": "\u221D" },
  "&vrtri;": { "codepoints": [8883], "characters": "\u22B3" },
  "&Vscr;": { "codepoints": [119985], "characters": "\uD835\uDCB1" },
  "&vscr;": { "codepoints": [120011], "characters": "\uD835\uDCCB" },
  "&vsubnE;": { "codepoints": [10955, 65024], "characters": "\u2ACB\uFE00" },
  "&vsubne;": { "codepoints": [8842, 65024], "characters": "\u228A\uFE00" },
  "&vsupnE;": { "codepoints": [10956, 65024], "characters": "\u2ACC\uFE00" },
  "&vsupne;": { "codepoints": [8843, 65024], "characters": "\u228B\uFE00" },
  "&Vvdash;": { "codepoints": [8874], "characters": "\u22AA" },
  "&vzigzag;": { "codepoints": [10650], "characters": "\u299A" },
  "&Wcirc;": { "codepoints": [372], "characters": "\u0174" },
  "&wcirc;": { "codepoints": [373], "characters": "\u0175" },
  "&wedbar;": { "codepoints": [10847], "characters": "\u2A5F" },
  "&wedge;": { "codepoints": [8743], "characters": "\u2227" },
  "&Wedge;": { "codepoints": [8896], "characters": "\u22C0" },
  "&wedgeq;": { "codepoints": [8793], "characters": "\u2259" },
  "&weierp;": { "codepoints": [8472], "characters": "\u2118" },
  "&Wfr;": { "codepoints": [120090], "characters": "\uD835\uDD1A" },
  "&wfr;": { "codepoints": [120116], "characters": "\uD835\uDD34" },
  "&Wopf;": { "codepoints": [120142], "characters": "\uD835\uDD4E" },
  "&wopf;": { "codepoints": [120168], "characters": "\uD835\uDD68" },
  "&wp;": { "codepoints": [8472], "characters": "\u2118" },
  "&wr;": { "codepoints": [8768], "characters": "\u2240" },
  "&wreath;": { "codepoints": [8768], "characters": "\u2240" },
  "&Wscr;": { "codepoints": [119986], "characters": "\uD835\uDCB2" },
  "&wscr;": { "codepoints": [120012], "characters": "\uD835\uDCCC" },
  "&xcap;": { "codepoints": [8898], "characters": "\u22C2" },
  "&xcirc;": { "codepoints": [9711], "characters": "\u25EF" },
  "&xcup;": { "codepoints": [8899], "characters": "\u22C3" },
  "&xdtri;": { "codepoints": [9661], "characters": "\u25BD" },
  "&Xfr;": { "codepoints": [120091], "characters": "\uD835\uDD1B" },
  "&xfr;": { "codepoints": [120117], "characters": "\uD835\uDD35" },
  "&xharr;": { "codepoints": [10231], "characters": "\u27F7" },
  "&xhArr;": { "codepoints": [10234], "characters": "\u27FA" },
  "&Xi;": { "codepoints": [926], "characters": "\u039E" },
  "&xi;": { "codepoints": [958], "characters": "\u03BE" },
  "&xlarr;": { "codepoints": [10229], "characters": "\u27F5" },
  "&xlArr;": { "codepoints": [10232], "characters": "\u27F8" },
  "&xmap;": { "codepoints": [10236], "characters": "\u27FC" },
  "&xnis;": { "codepoints": [8955], "characters": "\u22FB" },
  "&xodot;": { "codepoints": [10752], "characters": "\u2A00" },
  "&Xopf;": { "codepoints": [120143], "characters": "\uD835\uDD4F" },
  "&xopf;": { "codepoints": [120169], "characters": "\uD835\uDD69" },
  "&xoplus;": { "codepoints": [10753], "characters": "\u2A01" },
  "&xotime;": { "codepoints": [10754], "characters": "\u2A02" },
  "&xrarr;": { "codepoints": [10230], "characters": "\u27F6" },
  "&xrArr;": { "codepoints": [10233], "characters": "\u27F9" },
  "&Xscr;": { "codepoints": [119987], "characters": "\uD835\uDCB3" },
  "&xscr;": { "codepoints": [120013], "characters": "\uD835\uDCCD" },
  "&xsqcup;": { "codepoints": [10758], "characters": "\u2A06" },
  "&xuplus;": { "codepoints": [10756], "characters": "\u2A04" },
  "&xutri;": { "codepoints": [9651], "characters": "\u25B3" },
  "&xvee;": { "codepoints": [8897], "characters": "\u22C1" },
  "&xwedge;": { "codepoints": [8896], "characters": "\u22C0" },
  "&Yacute;": { "codepoints": [221], "characters": "\u00DD" },
  "&Yacute": { "codepoints": [221], "characters": "\u00DD" },
  "&yacute;": { "codepoints": [253], "characters": "\u00FD" },
  "&yacute": { "codepoints": [253], "characters": "\u00FD" },
  "&YAcy;": { "codepoints": [1071], "characters": "\u042F" },
  "&yacy;": { "codepoints": [1103], "characters": "\u044F" },
  "&Ycirc;": { "codepoints": [374], "characters": "\u0176" },
  "&ycirc;": { "codepoints": [375], "characters": "\u0177" },
  "&Ycy;": { "codepoints": [1067], "characters": "\u042B" },
  "&ycy;": { "codepoints": [1099], "characters": "\u044B" },
  "&yen;": { "codepoints": [165], "characters": "\u00A5" },
  "&yen": { "codepoints": [165], "characters": "\u00A5" },
  "&Yfr;": { "codepoints": [120092], "characters": "\uD835\uDD1C" },
  "&yfr;": { "codepoints": [120118], "characters": "\uD835\uDD36" },
  "&YIcy;": { "codepoints": [1031], "characters": "\u0407" },
  "&yicy;": { "codepoints": [1111], "characters": "\u0457" },
  "&Yopf;": { "codepoints": [120144], "characters": "\uD835\uDD50" },
  "&yopf;": { "codepoints": [120170], "characters": "\uD835\uDD6A" },
  "&Yscr;": { "codepoints": [119988], "characters": "\uD835\uDCB4" },
  "&yscr;": { "codepoints": [120014], "characters": "\uD835\uDCCE" },
  "&YUcy;": { "codepoints": [1070], "characters": "\u042E" },
  "&yucy;": { "codepoints": [1102], "characters": "\u044E" },
  "&yuml;": { "codepoints": [255], "characters": "\u00FF" },
  "&yuml": { "codepoints": [255], "characters": "\u00FF" },
  "&Yuml;": { "codepoints": [376], "characters": "\u0178" },
  "&Zacute;": { "codepoints": [377], "characters": "\u0179" },
  "&zacute;": { "codepoints": [378], "characters": "\u017A" },
  "&Zcaron;": { "codepoints": [381], "characters": "\u017D" },
  "&zcaron;": { "codepoints": [382], "characters": "\u017E" },
  "&Zcy;": { "codepoints": [1047], "characters": "\u0417" },
  "&zcy;": { "codepoints": [1079], "characters": "\u0437" },
  "&Zdot;": { "codepoints": [379], "characters": "\u017B" },
  "&zdot;": { "codepoints": [380], "characters": "\u017C" },
  "&zeetrf;": { "codepoints": [8488], "characters": "\u2128" },
  "&ZeroWidthSpace;": { "codepoints": [8203], "characters": "\u200B" },
  "&Zeta;": { "codepoints": [918], "characters": "\u0396" },
  "&zeta;": { "codepoints": [950], "characters": "\u03B6" },
  "&zfr;": { "codepoints": [120119], "characters": "\uD835\uDD37" },
  "&Zfr;": { "codepoints": [8488], "characters": "\u2128" },
  "&ZHcy;": { "codepoints": [1046], "characters": "\u0416" },
  "&zhcy;": { "codepoints": [1078], "characters": "\u0436" },
  "&zigrarr;": { "codepoints": [8669], "characters": "\u21DD" },
  "&zopf;": { "codepoints": [120171], "characters": "\uD835\uDD6B" },
  "&Zopf;": { "codepoints": [8484], "characters": "\u2124" },
  "&Zscr;": { "codepoints": [119989], "characters": "\uD835\uDCB5" },
  "&zscr;": { "codepoints": [120015], "characters": "\uD835\uDCCF" },
  "&zwj;": { "codepoints": [8205], "characters": "\u200D" },
  "&zwnj;": { "codepoints": [8204], "characters": "\u200C" }
};

var ALPHANUMERIC = /^[a-zA-Z0-9]/;
var getPossibleNamedEntityStart = makeRegexMatcher(/^&[a-zA-Z0-9]/);
var getApparentNamedEntity = makeRegexMatcher(/^&[a-zA-Z0-9]+;/);

var getNamedEntityByFirstChar = {};
(function () {
  var namedEntitiesByFirstChar = {};
  for (var ent in ENTITIES) {
    var chr = ent.charAt(1);
    namedEntitiesByFirstChar[chr] = (namedEntitiesByFirstChar[chr] || []);
    namedEntitiesByFirstChar[chr].push(ent.slice(2));
  }
  for (var chr in namedEntitiesByFirstChar) {
    getNamedEntityByFirstChar[chr] = makeRegexMatcher(
      new RegExp('^&' + chr + '(?:' +
                 namedEntitiesByFirstChar[chr].join('|') + ')'));
  }
})();

// Run a provided "matcher" function but reset the current position afterwards.
// Fatal failure of the matcher is not suppressed.
var peekMatcher = function (scanner, matcher) {
  var start = scanner.pos;
  var result = matcher(scanner);
  scanner.pos = start;
  return result;
};

// Returns a string like "&amp;" or a falsy value if no match.  Fails fatally
// if something looks like a named entity but isn't.
var getNamedCharRef = function (scanner, inAttribute) {
  // look for `&` followed by alphanumeric
  if (! peekMatcher(scanner, getPossibleNamedEntityStart))
    return null;

  var matcher = getNamedEntityByFirstChar[scanner.rest().charAt(1)];
  var entity = null;
  if (matcher)
    entity = peekMatcher(scanner, matcher);

  if (entity) {
    if (entity.slice(-1) !== ';') {
      // Certain character references with no semi are an error, like `&lt`.
      // In attribute values, however, this is not fatal if the next character
      // is alphanumeric.
      //
      // This rule affects href attributes, for example, deeming "/?foo=bar&ltc=abc"
      // to be ok but "/?foo=bar&lt=abc" to not be.
      if (inAttribute && ALPHANUMERIC.test(scanner.rest().charAt(entity.length)))
        return null;
      scanner.fatal("Character reference requires semicolon: " + entity);
    } else {
      scanner.pos += entity.length;
      return entity;
    }
  } else {
    // we couldn't match any real entity, so see if this is a bad entity
    // or something we can overlook.
    var badEntity = peekMatcher(scanner, getApparentNamedEntity);
    if (badEntity)
      scanner.fatal("Invalid character reference: " + badEntity);
    // `&aaaa` is ok with no semicolon
    return null;
  }
};

// Returns the sequence of one or two codepoints making up an entity as an array.
// Codepoints in the array are integers and may be out of the single-char JavaScript
// range.
var getCodePoints = function (namedEntity) {
  return ENTITIES[namedEntity].codepoints;
};

var ALLOWED_AFTER_AMP = /^[\u0009\u000a\u000c <&]/;

var getCharRefNumber = makeRegexMatcher(/^(?:[xX][0-9a-fA-F]+|[0-9]+);/);

var BIG_BAD_CODEPOINTS = (function (obj) {
  var list = [0x1FFFE, 0x1FFFF, 0x2FFFE, 0x2FFFF, 0x3FFFE, 0x3FFFF,
              0x4FFFE, 0x4FFFF, 0x5FFFE, 0x5FFFF, 0x6FFFE, 0x6FFFF,
              0x7FFFE, 0x7FFFF, 0x8FFFE, 0x8FFFF, 0x9FFFE, 0x9FFFF,
              0xAFFFE, 0xAFFFF, 0xBFFFE, 0xBFFFF, 0xCFFFE, 0xCFFFF,
              0xDFFFE, 0xDFFFF, 0xEFFFE, 0xEFFFF, 0xFFFFE, 0xFFFFF,
              0x10FFFE, 0x10FFFF];
  for (var i = 0; i < list.length; i++)
    obj[list[i]] = true;

  return obj;
})({});

var isLegalCodepoint = function (cp) {
  if ((cp === 0) ||
      (cp >= 0x80 && cp <= 0x9f) ||
      (cp >= 0xd800 && cp <= 0xdfff) ||
      (cp >= 0x10ffff) ||
      (cp >= 0x1 && cp <= 0x8) ||
      (cp === 0xb) ||
      (cp >= 0xd && cp <= 0x1f) ||
      (cp >= 0x7f && cp <= 0x9f) ||
      (cp >= 0xfdd0 && cp <= 0xfdef) ||
      (cp === 0xfffe) ||
      (cp === 0xffff) ||
      (cp >= 0x10000 && BIG_BAD_CODEPOINTS[cp]))
    return false;

  return true;
};

// http://www.whatwg.org/specs/web-apps/current-work/multipage/tokenization.html#consume-a-character-reference
//
// Matches a character reference if possible, including the initial `&`.
// Fails fatally in error cases (assuming an initial `&` is matched), like a disallowed codepoint
// number or a bad named character reference.
//
// `inAttribute` is truthy if we are in an attribute value.
//
// `allowedChar` is an optional character that,
// if found after the initial `&`, aborts parsing silently rather than failing fatally.  In real use it is
// either `"`, `'`, or `>` and is supplied when parsing attribute values.  NOTE: In the current spec, the
// value of `allowedChar` doesn't actually seem to end up mattering, but there is still some debate about
// the right approach to ampersands.
getCharacterReference = HTMLTools.Parse.getCharacterReference = function (scanner, inAttribute, allowedChar) {
  if (scanner.peek() !== '&')
    // no ampersand
    return null;

  var afterAmp = scanner.rest().charAt(1);

  if (afterAmp === '#') {
    scanner.pos += 2;
    // refNumber includes possible initial `x` and final semicolon
    var refNumber = getCharRefNumber(scanner);
    // At this point we've consumed the input, so we're committed to returning
    // something or failing fatally.
    if (! refNumber)
      scanner.fatal("Invalid numerical character reference starting with &#");
    var codepoint;
    if (refNumber.charAt(0) === 'x' || refNumber.charAt(0) === 'X') {
      // hex
      var hex = refNumber.slice(1, -1);
      while (hex.charAt(0) === '0')
        hex = hex.slice(1);
      if (hex.length > 6)
        scanner.fatal("Numerical character reference too large: 0x" + hex);
      codepoint = parseInt(hex || "0", 16);
    } else {
      var dec = refNumber.slice(0, -1);
      while (dec.charAt(0) === '0')
        dec = dec.slice(1);
      if (dec.length > 7)
        scanner.fatal("Numerical character reference too large: " + dec);
      codepoint = parseInt(dec || "0", 10);
    }
    if (! isLegalCodepoint(codepoint))
      scanner.fatal("Illegal codepoint in numerical character reference: &#" + refNumber);
    return { t: 'CharRef',
             v: '&#' + refNumber,
             cp: [codepoint] };
  } else if ((! afterAmp) // EOF
             || (allowedChar && afterAmp === allowedChar)
             || ALLOWED_AFTER_AMP.test(afterAmp)) {
    return null;
  } else {
    var namedEntity = getNamedCharRef(scanner, inAttribute);
    if (namedEntity) {
      return { t: 'CharRef',
               v: namedEntity,
               cp: getCodePoints(namedEntity) };
    } else {
      return null;
    }
  }
};


}).call(this);






(function () {

                                                                                                               //
// Token types:
//
// { t: 'Doctype',
//   v: String (entire Doctype declaration from the source),
//   name: String,
//   systemId: String (optional),
//   publicId: String (optional)
// }
//
// { t: 'Comment',
//   v: String (not including "<!--" and "-->")
// }
//
// { t: 'Chars',
//   v: String (pure text like you might pass to document.createTextNode,
//              no character references)
// }
//
// { t: 'Tag',
//   isEnd: Boolean (optional),
//   isSelfClosing: Boolean (optional),
//   n: String (tag name, in lowercase or camel case),
//   attrs: { String: [zero or more 'Chars' or 'CharRef' objects] }
//     (only for start tags; required)
// }
//
// { t: 'CharRef',
//   v: String (entire character reference from the source, e.g. "&amp;"),
//   cp: [Integer] (array of Unicode code point numbers it expands to)
// }
//
// We keep around both the original form of the character reference and its
// expansion so that subsequent processing steps have the option to
// re-emit it (if they are generating HTML) or interpret it.  Named and
// numerical code points may be more than 16 bits, in which case they
// need to passed through codePointToString to make a JavaScript string.
// Most named entities and all numeric character references are one codepoint
// (e.g. "&amp;" is [38]), but a few are two codepoints.
//
// { t: 'Special',
//   v: { ... anything ... }
// }

// The HTML tokenization spec says to preprocess the input stream to replace
// CR(LF)? with LF.  However, preprocessing `scanner` would complicate things
// by making indexes not match the input (e.g. for error messages), so we just
// keep in mind as we go along that an LF might be represented by CRLF or CR.
// In most cases, it doesn't actually matter what combination of whitespace
// characters are present (e.g. inside tags).
var HTML_SPACE = /^[\f\n\r\t ]/;

var convertCRLF = function (str) {
  return str.replace(/\r\n?/g, '\n');
};

getComment = HTMLTools.Parse.getComment = function (scanner) {
  if (scanner.rest().slice(0, 4) !== '<!--')
    return null;
  scanner.pos += 4;

  // Valid comments are easy to parse; they end at the first `--`!
  // Our main job is throwing errors.

  var rest = scanner.rest();
  if (rest.charAt(0) === '>' || rest.slice(0, 2) === '->')
    scanner.fatal("HTML comment can't start with > or ->");

  var closePos = rest.indexOf('-->');
  if (closePos < 0)
    scanner.fatal("Unclosed HTML comment");

  var commentContents = rest.slice(0, closePos);
  if (commentContents.slice(-1) === '-')
    scanner.fatal("HTML comment must end at first `--`");
  if (commentContents.indexOf("--") >= 0)
    scanner.fatal("HTML comment cannot contain `--` anywhere");
  if (commentContents.indexOf('\u0000') >= 0)
    scanner.fatal("HTML comment cannot contain NULL");

  scanner.pos += closePos + 3;

  return { t: 'Comment',
           v: convertCRLF(commentContents) };
};

var skipSpaces = function (scanner) {
  while (HTML_SPACE.test(scanner.peek()))
    scanner.pos++;
};

var requireSpaces = function (scanner) {
  if (! HTML_SPACE.test(scanner.peek()))
    scanner.fatal("Expected space");
  skipSpaces(scanner);
};

var getDoctypeQuotedString = function (scanner) {
  var quote = scanner.peek();
  if (! (quote === '"' || quote === "'"))
    scanner.fatal("Expected single or double quote in DOCTYPE");
  scanner.pos++;

  if (scanner.peek() === quote)
    // prevent a falsy return value (empty string)
    scanner.fatal("Malformed DOCTYPE");

  var str = '';
  var ch;
  while ((ch = scanner.peek()), ch !== quote) {
    if ((! ch) || (ch === '\u0000') || (ch === '>'))
      scanner.fatal("Malformed DOCTYPE");
    str += ch;
    scanner.pos++;
  }

  scanner.pos++;

  return str;
};

// See http://www.whatwg.org/specs/web-apps/current-work/multipage/syntax.html#the-doctype.
//
// If `getDocType` sees "<!DOCTYPE" (case-insensitive), it will match or fail fatally.
getDoctype = HTMLTools.Parse.getDoctype = function (scanner) {
  if (HTMLTools.asciiLowerCase(scanner.rest().slice(0, 9)) !== '<!doctype')
    return null;
  var start = scanner.pos;
  scanner.pos += 9;

  requireSpaces(scanner);

  var ch = scanner.peek();
  if ((! ch) || (ch === '>') || (ch === '\u0000'))
    scanner.fatal('Malformed DOCTYPE');
  var name = ch;
  scanner.pos++;

  while ((ch = scanner.peek()), ! (HTML_SPACE.test(ch) || ch === '>')) {
    if ((! ch) || (ch === '\u0000'))
      scanner.fatal('Malformed DOCTYPE');
    name += ch;
    scanner.pos++;
  }
  name = HTMLTools.asciiLowerCase(name);

  // Now we're looking at a space or a `>`.
  skipSpaces(scanner);

  var systemId = null;
  var publicId = null;

  if (scanner.peek() !== '>') {
    // Now we're essentially in the "After DOCTYPE name state" of the tokenizer,
    // but we're not looking at space or `>`.

    // this should be "public" or "system".
    var publicOrSystem = HTMLTools.asciiLowerCase(scanner.rest().slice(0, 6));

    if (publicOrSystem === 'system') {
      scanner.pos += 6;
      requireSpaces(scanner);
      systemId = getDoctypeQuotedString(scanner);
      skipSpaces(scanner);
      if (scanner.peek() !== '>')
        scanner.fatal("Malformed DOCTYPE");
    } else if (publicOrSystem === 'public') {
      scanner.pos += 6;
      requireSpaces(scanner);
      publicId = getDoctypeQuotedString(scanner);
      if (scanner.peek() !== '>') {
        requireSpaces(scanner);
        if (scanner.peek() !== '>') {
          systemId = getDoctypeQuotedString(scanner);
          skipSpaces(scanner);
          if (scanner.peek() !== '>')
            scanner.fatal("Malformed DOCTYPE");
        }
      }
    } else {
      scanner.fatal("Expected PUBLIC or SYSTEM in DOCTYPE");
    }
  }

  // looking at `>`
  scanner.pos++;
  var result = { t: 'Doctype',
                 v: scanner.input.slice(start, scanner.pos),
                 name: name };

  if (systemId)
    result.systemId = systemId;
  if (publicId)
    result.publicId = publicId;

  return result;
};

// The special character `{` is only allowed as the first character
// of a Chars, so that we have a chance to detect template tags.
var getChars = makeRegexMatcher(/^[^&<\u0000][^&<\u0000{]*/);

// Returns the next HTML token, or `null` if we reach EOF.
//
// Note that if we have a `getSpecialTag` function that sometimes
// consumes characters and emits nothing (e.g. in the case of template
// comments), we may go from not-at-EOF to at-EOF and return `null`,
// while otherwise we always find some token to return.
getHTMLToken = HTMLTools.Parse.getHTMLToken = function (scanner, dataMode) {
  var result = null;
  if (scanner.getSpecialTag) {
    var lastPos = -1;
    // Try to parse a "special tag" by calling out to the provided
    // `getSpecialTag` function.  If the function returns `null` but
    // consumes characters, it must have parsed a comment or something,
    // so we loop and try it again.  If it ever returns `null` without
    // consuming anything, that means it didn't see anything interesting
    // so we look for a normal token.  If it returns a truthy value,
    // the value must be an object.  We wrap it in a Special token.
    while ((! result) && scanner.pos > lastPos) {
      lastPos = scanner.pos;
      result = scanner.getSpecialTag(
        scanner,
        (dataMode === 'rcdata' ? TEMPLATE_TAG_POSITION.IN_RCDATA :
         (dataMode === 'rawtext' ? TEMPLATE_TAG_POSITION.IN_RAWTEXT :
          TEMPLATE_TAG_POSITION.ELEMENT)));
    }
    if (result)
      return { t: 'Special', v: result };
  }

  var chars = getChars(scanner);
  if (chars)
    return { t: 'Chars',
             v: convertCRLF(chars) };

  var ch = scanner.peek();
  if (! ch)
    return null; // EOF

  if (ch === '\u0000')
    scanner.fatal("Illegal NULL character");

  if (ch === '&') {
    if (dataMode !== 'rawtext') {
      var charRef = getCharacterReference(scanner);
      if (charRef)
        return charRef;
    }

    scanner.pos++;
    return { t: 'Chars',
             v: '&' };
  }

  // If we're here, we're looking at `<`.

  if (scanner.peek() === '<' && dataMode) {
    // don't interpret tags
    scanner.pos++;
    return { t: 'Chars',
             v: '<' };
  }

  // `getTag` will claim anything starting with `<` not followed by `!`.
  // `getComment` takes `<!--` and getDoctype takes `<!doctype`.
  result = (getTagToken(scanner) || getComment(scanner) || getDoctype(scanner));

  if (result)
    return result;

  scanner.fatal("Unexpected `<!` directive.");
};

var getTagName = makeRegexMatcher(/^[a-zA-Z][^\f\n\r\t />{]*/);
var getClangle = makeRegexMatcher(/^>/);
var getSlash = makeRegexMatcher(/^\//);
var getAttributeName = makeRegexMatcher(/^[^>/\u0000"'<=\f\n\r\t ][^\f\n\r\t /=>"'<\u0000]*/);

// Try to parse `>` or `/>`, mutating `tag` to be self-closing in the latter
// case (and failing fatally if `/` isn't followed by `>`).
// Return tag if successful.
var handleEndOfTag = function (scanner, tag) {
  if (getClangle(scanner))
    return tag;

  if (getSlash(scanner)) {
    if (! getClangle(scanner))
      scanner.fatal("Expected `>` after `/`");
    tag.isSelfClosing = true;
    return tag;
  }

  return null;
};

var getQuotedAttributeValue = function (scanner, quote) {
  if (scanner.peek() !== quote)
    return null;
  scanner.pos++;

  var tokens = [];
  var charsTokenToExtend = null;

  var charRef;
  while (true) {
    var ch = scanner.peek();
    var special;
    var curPos = scanner.pos;
    if (ch === quote) {
      scanner.pos++;
      return tokens;
    } else if (! ch) {
      scanner.fatal("Unclosed quoted attribute in tag");
    } else if (ch === '\u0000') {
      scanner.fatal("Unexpected NULL character in attribute value");
    } else if (ch === '&' && (charRef = getCharacterReference(scanner, true, quote))) {
      tokens.push(charRef);
      charsTokenToExtend = null;
    } else if (scanner.getSpecialTag &&
               ((special = scanner.getSpecialTag(scanner,
                                                 TEMPLATE_TAG_POSITION.IN_ATTRIBUTE)) ||
                scanner.pos > curPos /* `{{! comment}}` */)) {
      // note: this code is messy because it turns out to be annoying for getSpecialTag
      // to return `null` when it scans a comment.  Also, this code should be de-duped
      // with getUnquotedAttributeValue
      if (special) {
        tokens.push({t: 'Special', v: special});
        charsTokenToExtend = null;
      }
    } else {
      if (! charsTokenToExtend) {
        charsTokenToExtend = { t: 'Chars', v: '' };
        tokens.push(charsTokenToExtend);
      }
      charsTokenToExtend.v += (ch === '\r' ? '\n' : ch);
      scanner.pos++;
      if (ch === '\r' && scanner.peek() === '\n')
        scanner.pos++;
    }
  }
};

var getUnquotedAttributeValue = function (scanner) {
  var tokens = [];
  var charsTokenToExtend = null;

  var charRef;
  while (true) {
    var ch = scanner.peek();
    var special;
    var curPos = scanner.pos;
    if (HTML_SPACE.test(ch) || ch === '>') {
      return tokens;
    } else if (! ch) {
      scanner.fatal("Unclosed attribute in tag");
    } else if ('\u0000"\'<=`'.indexOf(ch) >= 0) {
      scanner.fatal("Unexpected character in attribute value");
    } else if (ch === '&' && (charRef = getCharacterReference(scanner, true, '>'))) {
      tokens.push(charRef);
      charsTokenToExtend = null;
    } else if (scanner.getSpecialTag &&
               ((special = scanner.getSpecialTag(scanner,
                                                 TEMPLATE_TAG_POSITION.IN_ATTRIBUTE)) ||
                scanner.pos > curPos /* `{{! comment}}` */)) {
      if (special) {
        tokens.push({t: 'Special', v: special});
        charsTokenToExtend = null;
      }
    } else {
      if (! charsTokenToExtend) {
        charsTokenToExtend = { t: 'Chars', v: '' };
        tokens.push(charsTokenToExtend);
      }
      charsTokenToExtend.v += ch;
      scanner.pos++;
    }
  }
};

getTagToken = HTMLTools.Parse.getTagToken = function (scanner) {
  if (! (scanner.peek() === '<' && scanner.rest().charAt(1) !== '!'))
    return null;
  scanner.pos++;

  var tag = { t: 'Tag' };

  // now looking at the character after `<`, which is not a `!`
  if (scanner.peek() === '/') {
    tag.isEnd = true;
    scanner.pos++;
  }

  var tagName = getTagName(scanner);
  if (! tagName)
    scanner.fatal("Expected tag name after `<`");
  tag.n = HTMLTools.properCaseTagName(tagName);

  if (scanner.peek() === '/' && tag.isEnd)
    scanner.fatal("End tag can't have trailing slash");
  if (handleEndOfTag(scanner, tag))
    return tag;

  if (scanner.isEOF())
    scanner.fatal("Unclosed `<`");

  if (! HTML_SPACE.test(scanner.peek()))
    // e.g. `<a{{b}}>`
    scanner.fatal("Expected space after tag name");

  // we're now in "Before attribute name state" of the tokenizer
  skipSpaces(scanner);

  if (scanner.peek() === '/' && tag.isEnd)
    scanner.fatal("End tag can't have trailing slash");
  if (handleEndOfTag(scanner, tag))
    return tag;

  if (tag.isEnd)
    scanner.fatal("End tag can't have attributes");

  tag.attrs = {};

  while (true) {
    // Note: at the top of this loop, we've already skipped any spaces.

    // This will be set to true if after parsing the attribute, we should
    // require spaces (or else an end of tag, i.e. `>` or `/>`).
    var spacesRequiredAfter = false;

    // first, try for a special tag.
    var curPos = scanner.pos;
    var special = (scanner.getSpecialTag &&
                   scanner.getSpecialTag(scanner,
                                         TEMPLATE_TAG_POSITION.IN_START_TAG));
    if (special || (scanner.pos > curPos)) {
      if (special) {
        tag.attrs.$specials = (tag.attrs.$specials || []);
        tag.attrs.$specials.push({ t: 'Special', v: special });
      } // else, must have scanned a `{{! comment}}`

      spacesRequiredAfter = true;
    } else {

      var attributeName = getAttributeName(scanner);
      if (! attributeName)
        scanner.fatal("Expected attribute name in tag");
      // Throw error on `{` in attribute name.  This provides *some* error message
      // if someone writes `<a x{{y}}>` or `<a x{{y}}=z>`.  The HTML tokenization
      // spec doesn't say that `{` is invalid, but the DOM API (setAttribute) won't
      // allow it, so who cares.
      if (attributeName.indexOf('{') >= 0)
        scanner.fatal("Unexpected `{` in attribute name.");
      attributeName = HTMLTools.properCaseAttributeName(attributeName);

      if (tag.attrs.hasOwnProperty(attributeName))
        scanner.fatal("Duplicate attribute in tag: " + attributeName);

      tag.attrs[attributeName] = [];

      skipSpaces(scanner);

      if (handleEndOfTag(scanner, tag))
        return tag;

      var ch = scanner.peek();
      if (! ch)
        scanner.fatal("Unclosed <");
      if ('\u0000"\'<'.indexOf(ch) >= 0)
        scanner.fatal("Unexpected character after attribute name in tag");

      if (ch === '=') {
        scanner.pos++;

        skipSpaces(scanner);

        ch = scanner.peek();
        if (! ch)
          scanner.fatal("Unclosed <");
        if ('\u0000><=`'.indexOf(ch) >= 0)
          scanner.fatal("Unexpected character after = in tag");

        if ((ch === '"') || (ch === "'"))
          tag.attrs[attributeName] = getQuotedAttributeValue(scanner, ch);
        else
          tag.attrs[attributeName] = getUnquotedAttributeValue(scanner);

        spacesRequiredAfter = true;
      }
    }
    // now we are in the "post-attribute" position, whether it was a special attribute
    // (like `{{x}}`) or a normal one (like `x` or `x=y`).

    if (handleEndOfTag(scanner, tag))
      return tag;

    if (scanner.isEOF())
      scanner.fatal("Unclosed `<`");

    if (spacesRequiredAfter)
      requireSpaces(scanner);
    else
      skipSpaces(scanner);

    if (handleEndOfTag(scanner, tag))
      return tag;
  }
};

TEMPLATE_TAG_POSITION = HTMLTools.TEMPLATE_TAG_POSITION = {
  ELEMENT: 1,
  IN_START_TAG: 2,
  IN_ATTRIBUTE: 3,
  IN_RCDATA: 4,
  IN_RAWTEXT: 5
};

// tagName must be proper case
isLookingAtEndTag = function (scanner, tagName) {
  var rest = scanner.rest();
  var pos = 0; // into rest
  var firstPart = /^<\/([a-zA-Z]+)/.exec(rest);
  if (firstPart &&
      HTMLTools.properCaseTagName(firstPart[1]) === tagName) {
    // we've seen `</foo`, now see if the end tag continues
    pos += firstPart[0].length;
    while (pos < rest.length && HTML_SPACE.test(rest.charAt(pos)))
      pos++;
    if (pos < rest.length && rest.charAt(pos) === '>')
      return true;
  }
  return false;
};


}).call(this);






(function () {

                                                                                                               //

HTMLTools.Special = function (value) {
  if (! (this instanceof HTMLTools.Special))
    // called without `new`
    return new HTMLTools.Special(value);

  this.value = value;
};
HTMLTools.Special.prototype.toJS = function (options) {
  // XXX this is weird because toJS is defined in spacebars-compiler.
  // Think about where HTMLTools.Special and toJS should go.
  return HTML.Tag.prototype.toJS.call({tagName: 'HTMLTools.Special',
                                       attrs: this.value,
                                       children: []},
                                      options);
};

// Parse a "fragment" of HTML, up to the end of the input or a particular
// template tag (using the "shouldStop" option).
HTMLTools.parseFragment = function (input, options) {
  var scanner;
  if (typeof input === 'string')
    scanner = new Scanner(input);
  else
    // input can be a scanner.  We'd better not have a different
    // value for the "getSpecialTag" option as when the scanner
    // was created, because we don't do anything special to reset
    // the value (which is attached to the scanner).
    scanner = input;

  // ```
  // { getSpecialTag: function (scanner, templateTagPosition) {
  //     if (templateTagPosition === HTMLTools.TEMPLATE_TAG_POSITION.ELEMENT) {
  //       ...
  // ```
  if (options && options.getSpecialTag)
    scanner.getSpecialTag = options.getSpecialTag;

  // function (scanner) -> boolean
  var shouldStop = options && options.shouldStop;

  var result;
  if (options && options.textMode) {
    if (options.textMode === HTML.TEXTMODE.STRING) {
      result = getRawText(scanner, null, shouldStop);
    } else if (options.textMode === HTML.TEXTMODE.RCDATA) {
      result = getRCData(scanner, null, shouldStop);
    } else {
      throw new Error("Unsupported textMode: " + options.textMode);
    }
  } else {
    result = getContent(scanner, shouldStop);
  }
  if (! scanner.isEOF()) {
    // If we aren't at the end of the input, we either stopped at an unmatched
    // HTML end tag or at a template tag (like `{{else}}` or `{{/if}}`).
    // Detect the former case (stopped at an HTML end tag) and throw a good
    // error.

    var posBefore = scanner.pos;

    try {
      var endTag = getHTMLToken(scanner);
    } catch (e) {
      // ignore errors from getSpecialTag
    }

    // XXX we make some assumptions about shouldStop here, like that it
    // won't tell us to stop at an HTML end tag.  Should refactor
    // `shouldStop` into something more suitable.
    if (endTag && endTag.t === 'Tag' && endTag.isEnd) {
      var closeTag = endTag.n;
      var isVoidElement = HTML.isVoidElement(closeTag);
      scanner.fatal("Unexpected HTML close tag" +
                    (isVoidElement ?
                     '.  <' + endTag.n + '> should have no close tag.' : ''));
    }

    scanner.pos = posBefore; // rewind, we'll continue parsing as usual

    // If no "shouldStop" option was provided, we should have consumed the whole
    // input.
    if (! shouldStop)
      scanner.fatal("Expected EOF");
  }

  return result;
};

// Take a numeric Unicode code point, which may be larger than 16 bits,
// and encode it as a JavaScript UTF-16 string.
//
// Adapted from
// http://stackoverflow.com/questions/7126384/expressing-utf-16-unicode-characters-in-javascript/7126661.
codePointToString = HTMLTools.codePointToString = function(cp) {
  if (cp >= 0 && cp <= 0xD7FF || cp >= 0xE000 && cp <= 0xFFFF) {
    return String.fromCharCode(cp);
  } else if (cp >= 0x10000 && cp <= 0x10FFFF) {

    // we substract 0x10000 from cp to get a 20-bit number
    // in the range 0..0xFFFF
    cp -= 0x10000;

    // we add 0xD800 to the number formed by the first 10 bits
    // to give the first byte
    var first = ((0xffc00 & cp) >> 10) + 0xD800;

    // we add 0xDC00 to the number formed by the low 10 bits
    // to give the second byte
    var second = (0x3ff & cp) + 0xDC00;

    return String.fromCharCode(first) + String.fromCharCode(second);
  } else {
    return '';
  }
};

getContent = HTMLTools.Parse.getContent = function (scanner, shouldStopFunc) {
  var items = [];

  while (! scanner.isEOF()) {
    if (shouldStopFunc && shouldStopFunc(scanner))
      break;

    var posBefore = scanner.pos;
    var token = getHTMLToken(scanner);
    if (! token)
      // tokenizer reached EOF on its own, e.g. while scanning
      // template comments like `{{! foo}}`.
      continue;

    if (token.t === 'Doctype') {
      scanner.fatal("Unexpected Doctype");
    } else if (token.t === 'Chars') {
      pushOrAppendString(items, token.v);
    } else if (token.t === 'CharRef') {
      items.push(convertCharRef(token));
    } else if (token.t === 'Comment') {
      items.push(HTML.Comment(token.v));
    } else if (token.t === 'Special') {
      // token.v is an object `{ ... }`
      items.push(HTMLTools.Special(token.v));
    } else if (token.t === 'Tag') {
      if (token.isEnd) {
        // Stop when we encounter an end tag at the top level.
        // Rewind; we'll re-parse the end tag later.
        scanner.pos = posBefore;
        break;
      }

      var tagName = token.n;
      // is this an element with no close tag (a BR, HR, IMG, etc.) based
      // on its name?
      var isVoid = HTML.isVoidElement(tagName);
      if (token.isSelfClosing) {
        if (! (isVoid || HTML.isKnownSVGElement(tagName) || tagName.indexOf(':') >= 0))
          scanner.fatal('Only certain elements like BR, HR, IMG, etc. (and foreign elements like SVG) are allowed to self-close');
      }

      // may be null
      var attrs = parseAttrs(token.attrs);

      var tagFunc = HTML.getTag(tagName);
      if (isVoid || token.isSelfClosing) {
        items.push(attrs ? tagFunc(attrs) : tagFunc());
      } else {
        // parse HTML tag contents.

        // HTML treats a final `/` in a tag as part of an attribute, as in `<a href=/foo/>`, but the template author who writes `<circle r={{r}}/>`, say, may not be thinking about that, so generate a good error message in the "looks like self-close" case.
        var looksLikeSelfClose = (scanner.input.substr(scanner.pos - 2, 2) === '/>');

        var content;
        if (token.n === 'textarea') {
          if (scanner.peek() === '\n')
            scanner.pos++;
          content = getRCData(scanner, token.n, shouldStopFunc);
        } else {
          content = getContent(scanner, shouldStopFunc);
        }

        var endTag = getHTMLToken(scanner);

        if (! (endTag && endTag.t === 'Tag' && endTag.isEnd && endTag.n === tagName))
          scanner.fatal('Expected "' + tagName + '" end tag' + (looksLikeSelfClose ? ' -- if the "<' + token.n + ' />" tag was supposed to self-close, try adding a space before the "/"' : ''));

        // XXX support implied end tags in cases allowed by the spec

        // make `content` into an array suitable for applying tag constructor
        // as in `FOO.apply(null, content)`.
        if (content == null)
          content = [];
        else if (! (content instanceof Array))
          content = [content];

        items.push(HTML.getTag(tagName).apply(
          null, (attrs ? [attrs] : []).concat(content)));
      }
    } else {
      scanner.fatal("Unknown token type: " + token.t);
    }
  }

  if (items.length === 0)
    return null;
  else if (items.length === 1)
    return items[0];
  else
    return items;
};

var pushOrAppendString = function (items, string) {
  if (items.length &&
      typeof items[items.length - 1] === 'string')
    items[items.length - 1] += string;
  else
    items.push(string);
};

// get RCDATA to go in the lowercase (or camel case) tagName (e.g. "textarea")
getRCData = HTMLTools.Parse.getRCData = function (scanner, tagName, shouldStopFunc) {
  var items = [];

  while (! scanner.isEOF()) {
    // break at appropriate end tag
    if (tagName && isLookingAtEndTag(scanner, tagName))
      break;

    if (shouldStopFunc && shouldStopFunc(scanner))
      break;

    var token = getHTMLToken(scanner, 'rcdata');
    if (! token)
      // tokenizer reached EOF on its own, e.g. while scanning
      // template comments like `{{! foo}}`.
      continue;

    if (token.t === 'Chars') {
      pushOrAppendString(items, token.v);
    } else if (token.t === 'CharRef') {
      items.push(convertCharRef(token));
    } else if (token.t === 'Special') {
      // token.v is an object `{ ... }`
      items.push(HTMLTools.Special(token.v));
    } else {
      // (can't happen)
      scanner.fatal("Unknown or unexpected token type: " + token.t);
    }
  }

  if (items.length === 0)
    return null;
  else if (items.length === 1)
    return items[0];
  else
    return items;
};

var getRawText = function (scanner, tagName, shouldStopFunc) {
  var items = [];

  while (! scanner.isEOF()) {
    // break at appropriate end tag
    if (tagName && isLookingAtEndTag(scanner, tagName))
      break;

    if (shouldStopFunc && shouldStopFunc(scanner))
      break;

    var token = getHTMLToken(scanner, 'rawtext');
    if (! token)
      // tokenizer reached EOF on its own, e.g. while scanning
      // template comments like `{{! foo}}`.
      continue;

    if (token.t === 'Chars') {
      pushOrAppendString(items, token.v);
    } else if (token.t === 'Special') {
      // token.v is an object `{ ... }`
      items.push(HTMLTools.Special(token.v));
    } else {
      // (can't happen)
      scanner.fatal("Unknown or unexpected token type: " + token.t);
    }
  }

  if (items.length === 0)
    return null;
  else if (items.length === 1)
    return items[0];
  else
    return items;
};

// Input: A token like `{ t: 'CharRef', v: '&amp;', cp: [38] }`.
//
// Output: A tag like `HTML.CharRef({ html: '&amp;', str: '&' })`.
var convertCharRef = function (token) {
  var codePoints = token.cp;
  var str = '';
  for (var i = 0; i < codePoints.length; i++)
    str += codePointToString(codePoints[i]);
  return HTML.CharRef({ html: token.v, str: str });
};

// Input is always a dictionary (even if zero attributes) and each
// value in the dictionary is an array of `Chars`, `CharRef`,
// and maybe `Special` tokens.
//
// Output is null if there are zero attributes, and otherwise a
// dictionary.  Each value in the dictionary is HTMLjs (e.g. a
// string or an array of `Chars`, `CharRef`, and `Special`
// nodes).
//
// An attribute value with no input tokens is represented as "",
// not an empty array, in order to prop open empty attributes
// with no template tags.
var parseAttrs = function (attrs) {
  var result = null;

  for (var k in attrs) {
    if (! result)
      result = {};

    var inValue = attrs[k];
    var outParts = [];
    for (var i = 0; i < inValue.length; i++) {
      var token = inValue[i];
      if (token.t === 'CharRef') {
        outParts.push(convertCharRef(token));
      } else if (token.t === 'Special') {
        outParts.push(HTMLTools.Special(token.v));
      } else if (token.t === 'Chars') {
        pushOrAppendString(outParts, token.v);
      }
    }

    if (k === '$specials') {
      // the `$specials` pseudo-attribute should always get an
      // array, even if there is only one Special.
      result[k] = outParts;
    } else {
      var outValue = (inValue.length === 0 ? '' :
                      (outParts.length === 1 ? outParts[0] : outParts));
      var properKey = HTMLTools.properCaseAttributeName(k);
      result[properKey] = outValue;
    }
  }

  return result;
};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['html-tools'] = {
  HTMLTools: HTMLTools
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;

/* Package-scope variables */
var HTML, callReactiveFunction, stopWithLater;

(function () {

                                                                                                        //

HTML = {};

HTML.isNully = function (node) {
  if (node == null)
    // null or undefined
    return true;

  if (node instanceof Array) {
    // is it an empty array or an array of all nully items?
    for (var i = 0; i < node.length; i++)
      if (! HTML.isNully(node[i]))
        return false;
    return true;
  }

  return false;
};

HTML.escapeData = function (str) {
  // string; escape the two special chars in HTML data and RCDATA
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;');
};


// The HTML spec and the DOM API (in particular `setAttribute`) have different
// definitions of what characters are legal in an attribute.  The HTML
// parser is extremely permissive (allowing, for example, `<a %=%>`), while
// `setAttribute` seems to use something like the XML grammar for names (and
// throws an error if a name is invalid, making that attribute unsettable).
// If we knew exactly what grammar browsers used for `setAttribute`, we could
// include various Unicode ranges in what's legal.  For now, allow ASCII chars
// that are known to be valid XML, valid HTML, and settable via `setAttribute`:
//
// * Starts with `:`, `_`, `A-Z` or `a-z`
// * Consists of any of those plus `-`, `.`, and `0-9`.
//
// See <http://www.w3.org/TR/REC-xml/#NT-Name> and
// <http://dev.w3.org/html5/markup/syntax.html#syntax-attributes>.
HTML.isValidAttributeName = function (name) {
  return /^[:_A-Za-z][:_A-Za-z0-9.\-]*/.test(name);
};


}).call(this);






(function () {

                                                                                                        //

// Tag instances are `instanceof HTML.Tag`.
//
// Tag objects should be considered immutable.
//
// This is a private constructor of an abstract class; don't call it.
HTML.Tag = function () {};
HTML.Tag.prototype.tagName = ''; // this will be set per Tag subclass
HTML.Tag.prototype.attrs = null;
HTML.Tag.prototype.children = Object.freeze ? Object.freeze([]) : [];

// Given "p", create and assign `HTML.P` if it doesn't already exist.
// Then return it.  `tagName` must have proper case (usually all lowercase).
HTML.getTag = function (tagName) {
  var symbolName = HTML.getSymbolName(tagName);
  if (symbolName === tagName) // all-caps tagName
    throw new Error("Use the lowercase or camelCase form of '" + tagName + "' here");

  if (! HTML[symbolName])
    HTML[symbolName] = makeTagConstructor(tagName);

  return HTML[symbolName];
};

// Given "p", make sure `HTML.P` exists.  `tagName` must have proper case
// (usually all lowercase).
HTML.ensureTag = function (tagName) {
  HTML.getTag(tagName); // don't return it
};

// Given "p" create the function `HTML.P`.
var makeTagConstructor = function (tagName) {
  // HTMLTag is the per-tagName constructor of a HTML.Tag subclass
  var HTMLTag = function (/*arguments*/) {
    // Work with or without `new`.  If not called with `new`,
    // perform instantiation by recursively calling this constructor.
    // We can't pass varargs, so pass no args.
    var instance = (this instanceof HTML.Tag) ? this : new HTMLTag;

    var i = 0;
    var attrs = arguments.length && arguments[0];
    if (attrs && (typeof attrs === 'object') &&
        (attrs.constructor === Object)) {
      instance.attrs = attrs;
      i++;
    }

    // If no children, don't create an array at all, use the prototype's
    // (frozen, empty) array.  This way we don't create an empty array
    // every time someone creates a tag without `new` and this constructor
    // calls itself with no arguments (above).
    if (i < arguments.length)
      instance.children = Array.prototype.slice.call(arguments, i);

    return instance;
  };
  HTMLTag.prototype = new HTML.Tag;
  HTMLTag.prototype.constructor = HTMLTag;
  HTMLTag.prototype.tagName = tagName;

  return HTMLTag;
};

var CharRef = HTML.CharRef = function (attrs) {
  if (! (this instanceof CharRef))
    // called without `new`
    return new CharRef(attrs);

  if (! (attrs && attrs.html && attrs.str))
    throw new Error(
      "HTML.CharRef must be constructed with ({html:..., str:...})");

  this.html = attrs.html;
  this.str = attrs.str;
};

var Comment = HTML.Comment = function (value) {
  if (! (this instanceof Comment))
    // called without `new`
    return new Comment(value);

  if (typeof value !== 'string')
    throw new Error('HTML.Comment must be constructed with a string');

  this.value = value;
  // Kill illegal hyphens in comment value (no way to escape them in HTML)
  this.sanitizedValue = value.replace(/^-|--+|-$/g, '');
};


//---------- KNOWN ELEMENTS

// These lists of known elements are public.  You can use them, for example, to
// write a helper that determines the proper case for an SVG element name.
// Such helpers that may not be needed at runtime are not provided here.

HTML.knownElementNames = 'a abbr acronym address applet area b base basefont bdo big blockquote body br button caption center cite code col colgroup dd del dfn dir div dl dt em fieldset font form frame frameset h1 h2 h3 h4 h5 h6 head hr html i iframe img input ins isindex kbd label legend li link map menu meta noframes noscript object ol optgroup option p param pre q s samp script select small span strike strong style sub sup table tbody td textarea tfoot th thead title tr tt u ul var article aside audio bdi canvas command data datagrid datalist details embed eventsource figcaption figure footer header hgroup keygen mark meter nav output progress ruby rp rt section source summary time track video wbr'.split(' ');

// omitted because also an HTML element: "a"
HTML.knownSVGElementNames = 'altGlyph altGlyphDef altGlyphItem animate animateColor animateMotion animateTransform circle clipPath color-profile cursor defs desc ellipse feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence filter font font-face font-face-format font-face-name font-face-src font-face-uri foreignObject g glyph glyphRef hkern image line linearGradient marker mask metadata missing-glyph path pattern polygon polyline radialGradient rect script set stop style svg switch symbol text textPath title tref tspan use view vkern'.split(' ');
// Append SVG element names to list of known element names
HTML.knownElementNames = HTML.knownElementNames.concat(HTML.knownSVGElementNames);

HTML.voidElementNames = 'area base br col command embed hr img input keygen link meta param source track wbr'.split(' ');

// Speed up search through lists of known elements by creating internal "sets"
// of strings.
var YES = {yes:true};
var makeSet = function (array) {
  var set = {};
  for (var i = 0; i < array.length; i++)
    set[array[i]] = YES;
  return set;
};
var voidElementSet = makeSet(HTML.voidElementNames);
var knownElementSet = makeSet(HTML.knownElementNames);
var knownSVGElementSet = makeSet(HTML.knownSVGElementNames);

// Is the given element (in proper case) a known HTML element?
// This includes SVG elements.
HTML.isKnownElement = function (name) {
  return knownElementSet[name] === YES;
};

// Is the given element (in proper case) an element with no end tag
// in HTML, like "br", "hr", or "input"?
HTML.isVoidElement = function (name) {
  return voidElementSet[name] === YES;
};

// Is the given element (in proper case) a known SVG element?
HTML.isKnownSVGElement = function (name) {
  return knownSVGElementSet[name] === YES;
};

// For code generators, is a particular tag (in proper case) guaranteed
// to be available on the HTML object (under the name returned by
// getSymbolName)?
HTML.isTagEnsured = function (t) {
  return HTML.isKnownElement(t);
};

// For code generators, take a tagName like "p" and return an uppercase
// symbol name like "P" which is available on the "HTML" object for
// known elements or after calling getTag or ensureTag.
HTML.getSymbolName = function (tagName) {
  // "foo-bar" -> "FOO_BAR"
  return tagName.toUpperCase().replace(/-/g, '_');
};

// Ensure tags for all known elements
for (var i = 0; i < HTML.knownElementNames.length; i++)
  HTML.ensureTag(HTML.knownElementNames[i]);


callReactiveFunction = function (func) {
  var result;
  var cc = Deps.currentComputation;
  var h = Deps.autorun(function (c) {
    result = func();
  });
  h.onInvalidate(function () {
    if (cc)
      cc.invalidate();
  });
  if (Deps.active) {
    Deps.onInvalidate(function () {
      h.stop();
      func.stop && func.stop();
    });
  } else {
    h.stop();
    func.stop && func.stop();
  }
  return result;
};

stopWithLater = function (instance) {
  if (instance.materialized && instance.materialized.isWith) {
    if (Deps.active) {
      instance.materialized();
    } else {
      if (instance.data) // `UI.With`
        instance.data.stop();
      else if (instance.v) // `Spacebars.With`
        instance.v.stop();
    }
  }
};

// Call all functions and instantiate all components, when fine-grained
// reactivity is not needed (for example, in attributes).
HTML.evaluate = function (node, parentComponent) {
  if (node == null) {
    return node;
  } else if (typeof node === 'function') {
    return HTML.evaluate(callReactiveFunction(node), parentComponent);
  } else if (node instanceof Array) {
    var result = [];
    for (var i = 0; i < node.length; i++)
      result.push(HTML.evaluate(node[i], parentComponent));
    return result;
  } else if (typeof node.instantiate === 'function') {
    // component
    var instance = node.instantiate(parentComponent || null);
    var content = instance.render('STATIC');
    stopWithLater(instance);
    return HTML.evaluate(content, instance);
  }  else if (node instanceof HTML.Tag) {
    var newChildren = [];
    for (var i = 0; i < node.children.length; i++)
      newChildren.push(HTML.evaluate(node.children[i], parentComponent));
    var newTag = HTML.getTag(node.tagName).apply(null, newChildren);
    newTag.attrs = {};
    for (var k in node.attrs)
      newTag.attrs[k] = HTML.evaluate(node.attrs[k], parentComponent);
    return newTag;
  } else {
    return node;
  }
};

var extendAttrs = function (tgt, src, parentComponent) {
  for (var k in src) {
    if (k === '$dynamic')
      continue;
    if (! HTML.isValidAttributeName(k))
      throw new Error("Illegal HTML attribute name: " + k);
    var value = HTML.evaluate(src[k], parentComponent);
    if (! HTML.isNully(value))
      tgt[k] = value;
  }
};

// Process the `attrs.$dynamic` directive, if present, returning the final
// attributes dictionary.  The value of `attrs.$dynamic` must be an array
// of attributes dictionaries or functions returning attribute dictionaries.
// These attributes are used to extend `attrs` as long as they are non-nully.
// All attributes are "evaluated," calling functions and instantiating
// components.
HTML.evaluateAttributes = function (attrs, parentComponent) {
  if (! attrs)
    return attrs;

  var result = {};
  extendAttrs(result, attrs, parentComponent);

  if ('$dynamic' in attrs) {
    if (! (attrs.$dynamic instanceof Array))
      throw new Error("$dynamic must be an array");
    // iterate over attrs.$dynamic, calling each element if it
    // is a function and then using it to extend `result`.
    var dynamics = attrs.$dynamic;
    for (var i = 0; i < dynamics.length; i++) {
      var moreAttrs = dynamics[i];
      if (typeof moreAttrs === 'function')
        moreAttrs = moreAttrs();
      extendAttrs(result, moreAttrs, parentComponent);
    }
  }

  return result;
};

HTML.Tag.prototype.evaluateAttributes = function (parentComponent) {
  return HTML.evaluateAttributes(this.attrs, parentComponent);
};

HTML.Raw = function (value) {
  if (! (this instanceof HTML.Raw))
    // called without `new`
    return new HTML.Raw(value);

  if (typeof value !== 'string')
    throw new Error('HTML.Raw must be constructed with a string');

  this.value = value;
};

HTML.EmitCode = function (value) {
  if (! (this instanceof HTML.EmitCode))
    // called without `new`
    return new HTML.EmitCode(value);

  if (typeof value !== 'string')
    throw new Error('HTML.EmitCode must be constructed with a string');

  this.value = value;
};


}).call(this);






(function () {

                                                                                                        //

HTML.toHTML = function (node, parentComponent) {
  if (node == null) {
    // null or undefined
    return '';
  } else if ((typeof node === 'string') || (typeof node === 'boolean') || (typeof node === 'number')) {
    // string; escape special chars
    return HTML.escapeData(String(node));
  } else if (node instanceof Array) {
    // array
    var parts = [];
    for (var i = 0; i < node.length; i++)
      parts.push(HTML.toHTML(node[i], parentComponent));
    return parts.join('');
  } else if (typeof node.instantiate === 'function') {
    // component
    var instance = node.instantiate(parentComponent || null);
    var content = instance.render('STATIC');
    stopWithLater(instance);
    // recurse with a new value for parentComponent
    return HTML.toHTML(content, instance);
  } else if (typeof node === 'function') {
    return HTML.toHTML(callReactiveFunction(node), parentComponent);
  } else if (node.toHTML) {
    // Tag or something else
    return node.toHTML(parentComponent);
  } else {
    throw new Error("Expected tag, string, array, component, null, undefined, or " +
                    "object with a toHTML method; found: " + node);
  }
};

HTML.Comment.prototype.toHTML = function () {
  return '<!--' + this.sanitizedValue + '-->';
};

HTML.CharRef.prototype.toHTML = function () {
  return this.html;
};

HTML.Raw.prototype.toHTML = function () {
  return this.value;
};

HTML.Tag.prototype.toHTML = function (parentComponent) {
  var attrStrs = [];
  var attrs = this.evaluateAttributes(parentComponent);
  if (attrs) {
    for (var k in attrs) {
      var v = HTML.toText(attrs[k], HTML.TEXTMODE.ATTRIBUTE, parentComponent);
      attrStrs.push(' ' + k + '="' + v + '"');
    }
  }

  var tagName = this.tagName;
  var startTag = '<' + tagName + attrStrs.join('') + '>';

  var childStrs = [];
  var content;
  if (tagName === 'textarea') {
    for (var i = 0; i < this.children.length; i++)
      childStrs.push(HTML.toText(this.children[i], HTML.TEXTMODE.RCDATA, parentComponent));

    content = childStrs.join('');
    if (content.slice(0, 1) === '\n')
      // TEXTAREA will absorb a newline, so if we see one, add
      // another one.
      content = '\n' + content;

  } else {
    for (var i = 0; i < this.children.length; i++)
      childStrs.push(HTML.toHTML(this.children[i], parentComponent));

    content = childStrs.join('');
  }

  var result = startTag + content;

  if (this.children.length || ! HTML.isVoidElement(tagName)) {
    // "Void" elements like BR are the only ones that don't get a close
    // tag in HTML5.  They shouldn't have contents, either, so we could
    // throw an error upon seeing contents here.
    result += '</' + tagName + '>';
  }

  return result;
};

HTML.TEXTMODE = {
  ATTRIBUTE: 1,
  RCDATA: 2,
  STRING: 3
};

HTML.toText = function (node, textMode, parentComponent) {
  if (node == null) {
    // null or undefined
    return '';
  } else if ((typeof node === 'string') || (typeof node === 'boolean') || (typeof node === 'number')) {
    node = String(node);
    // string
    if (textMode === HTML.TEXTMODE.STRING) {
      return node;
    } else if (textMode === HTML.TEXTMODE.RCDATA) {
      return HTML.escapeData(node);
    } else if (textMode === HTML.TEXTMODE.ATTRIBUTE) {
      // escape `&` and `"` this time, not `&` and `<`
      return node.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    } else {
      throw new Error("Unknown TEXTMODE: " + textMode);
    }
  } else if (node instanceof Array) {
    // array
    var parts = [];
    for (var i = 0; i < node.length; i++)
      parts.push(HTML.toText(node[i], textMode, parentComponent));
    return parts.join('');
  } else if (typeof node === 'function') {
    return HTML.toText(callReactiveFunction(node), textMode, parentComponent);
  } else if (typeof node.instantiate === 'function') {
    // component
    var instance = node.instantiate(parentComponent || null);
    var content = instance.render('STATIC');
    var result = HTML.toText(content, textMode, instance);
    stopWithLater(instance);
    return result;
  } else if (node.toText) {
    // Something else
    return node.toText(textMode, parentComponent);
  } else {
    throw new Error("Expected tag, string, array, component, null, undefined, or " +
                    "object with a toText method; found: " + node);
  }

};

HTML.Raw.prototype.toText = function () {
  return this.value;
};

// used when including templates within {{#markdown}}
HTML.Tag.prototype.toText = function (textMode, parentComponent) {
  if (textMode === HTML.TEXTMODE.STRING)
    // stringify the tag as HTML, then convert to text
    return HTML.toText(this.toHTML(parentComponent), textMode);
  else
    throw new Error("Can't insert tags in attributes or TEXTAREA elements");
};

HTML.CharRef.prototype.toText = function (textMode) {
  if (textMode === HTML.TEXTMODE.STRING)
    return this.str;
  else if (textMode === HTML.TEXTMODE.RCDATA)
    return this.html;
  else if (textMode === HTML.TEXTMODE.ATTRIBUTE)
    return this.html;
  else
    throw new Error("Unknown TEXTMODE: " + textMode);
};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.htmljs = {
  HTML: HTML
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var _ = Package.underscore._;
var JSON = Package.json.JSON;
var EJSON = Package.ejson.EJSON;

/* Package-scope variables */
var IdMap;

(function () {

                                                                              //
IdMap = function (idStringify, idParse) {
  var self = this;
  self._map = {};
  self._idStringify = idStringify || JSON.stringify;
  self._idParse = idParse || JSON.parse;
};

// Some of these methods are designed to match methods on OrderedDict, since
// (eg) ObserveMultiplex and _CachingChangeObserver use them interchangeably.
// (Conceivably, this should be replaced with "UnorderedDict" with a specific
// set of methods that overlap between the two.)

_.extend(IdMap.prototype, {
  get: function (id) {
    var self = this;
    var key = self._idStringify(id);
    return self._map[key];
  },
  set: function (id, value) {
    var self = this;
    var key = self._idStringify(id);
    self._map[key] = value;
  },
  remove: function (id) {
    var self = this;
    var key = self._idStringify(id);
    delete self._map[key];
  },
  has: function (id) {
    var self = this;
    var key = self._idStringify(id);
    return _.has(self._map, key);
  },
  empty: function () {
    var self = this;
    return _.isEmpty(self._map);
  },
  clear: function () {
    var self = this;
    self._map = {};
  },
  // Iterates over the items in the map. Return `false` to break the loop.
  forEach: function (iterator) {
    var self = this;
    // don't use _.each, because we can't break out of it.
    var keys = _.keys(self._map);
    for (var i = 0; i < keys.length; i++) {
      var breakIfFalse = iterator.call(null, self._map[keys[i]],
                                       self._idParse(keys[i]));
      if (breakIfFalse === false)
        return;
    }
  },
  size: function () {
    var self = this;
    return _.size(self._map);
  },
  setDefault: function (id, def) {
    var self = this;
    var key = self._idStringify(id);
    if (_.has(self._map, key))
      return self._map[key];
    self._map[key] = def;
    return def;
  },
  // Assumes that values are EJSON-cloneable, and that we don't need to clone
  // IDs (ie, that nobody is going to mutate an ObjectId).
  clone: function () {
    var self = this;
    var clone = new IdMap(self._idStringify, self._idParse);
    self.forEach(function (value, id) {
      clone.set(id, EJSON.clone(value));
    });
    return clone;
  }
});



}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['id-map'] = {
  IdMap: IdMap
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;



/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.insecure = {};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;

/* Package-scope variables */
var $, jQuery;

(function () {

                                                                                                                     //
/*!
 * jQuery JavaScript Library v1.11.0
 * http://jquery.com/
 *
 * Includes Sizzle.js
 * http://sizzlejs.com/
 *
 * Copyright 2005, 2014 jQuery Foundation, Inc. and other contributors
 * Released under the MIT license
 * http://jquery.org/license
 *
 * Date: 2014-01-23T21:02Z
 */

(function( global, factory ) {

	if ( typeof module === "object" && typeof module.exports === "object" ) {
		// For CommonJS and CommonJS-like environments where a proper window is present,
		// execute the factory and get jQuery
		// For environments that do not inherently posses a window with a document
		// (such as Node.js), expose a jQuery-making factory as module.exports
		// This accentuates the need for the creation of a real window
		// e.g. var jQuery = require("jquery")(window);
		// See ticket #14549 for more info
		module.exports = global.document ?
			factory( global, true ) :
			function( w ) {
				if ( !w.document ) {
					throw new Error( "jQuery requires a window with a document" );
				}
				return factory( w );
			};
	} else {
		factory( global );
	}

// Pass this if window is not defined yet
}(typeof window !== "undefined" ? window : this, function( window, noGlobal ) {

// Can't do this because several apps including ASP.NET trace
// the stack via arguments.caller.callee and Firefox dies if
// you try to trace through "use strict" call chains. (#13335)
// Support: Firefox 18+
//

var deletedIds = [];

var slice = deletedIds.slice;

var concat = deletedIds.concat;

var push = deletedIds.push;

var indexOf = deletedIds.indexOf;

var class2type = {};

var toString = class2type.toString;

var hasOwn = class2type.hasOwnProperty;

var trim = "".trim;

var support = {};



var
	version = "1.11.0",

	// Define a local copy of jQuery
	jQuery = function( selector, context ) {
		// The jQuery object is actually just the init constructor 'enhanced'
		// Need init if jQuery is called (just allow error to be thrown if not included)
		return new jQuery.fn.init( selector, context );
	},

	// Make sure we trim BOM and NBSP (here's looking at you, Safari 5.0 and IE)
	rtrim = /^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g,

	// Matches dashed string for camelizing
	rmsPrefix = /^-ms-/,
	rdashAlpha = /-([\da-z])/gi,

	// Used by jQuery.camelCase as callback to replace()
	fcamelCase = function( all, letter ) {
		return letter.toUpperCase();
	};

jQuery.fn = jQuery.prototype = {
	// The current version of jQuery being used
	jquery: version,

	constructor: jQuery,

	// Start with an empty selector
	selector: "",

	// The default length of a jQuery object is 0
	length: 0,

	toArray: function() {
		return slice.call( this );
	},

	// Get the Nth element in the matched element set OR
	// Get the whole matched element set as a clean array
	get: function( num ) {
		return num != null ?

			// Return a 'clean' array
			( num < 0 ? this[ num + this.length ] : this[ num ] ) :

			// Return just the object
			slice.call( this );
	},

	// Take an array of elements and push it onto the stack
	// (returning the new matched element set)
	pushStack: function( elems ) {

		// Build a new jQuery matched element set
		var ret = jQuery.merge( this.constructor(), elems );

		// Add the old object onto the stack (as a reference)
		ret.prevObject = this;
		ret.context = this.context;

		// Return the newly-formed element set
		return ret;
	},

	// Execute a callback for every element in the matched set.
	// (You can seed the arguments with an array of args, but this is
	// only used internally.)
	each: function( callback, args ) {
		return jQuery.each( this, callback, args );
	},

	map: function( callback ) {
		return this.pushStack( jQuery.map(this, function( elem, i ) {
			return callback.call( elem, i, elem );
		}));
	},

	slice: function() {
		return this.pushStack( slice.apply( this, arguments ) );
	},

	first: function() {
		return this.eq( 0 );
	},

	last: function() {
		return this.eq( -1 );
	},

	eq: function( i ) {
		var len = this.length,
			j = +i + ( i < 0 ? len : 0 );
		return this.pushStack( j >= 0 && j < len ? [ this[j] ] : [] );
	},

	end: function() {
		return this.prevObject || this.constructor(null);
	},

	// For internal use only.
	// Behaves like an Array's method, not like a jQuery method.
	push: push,
	sort: deletedIds.sort,
	splice: deletedIds.splice
};

jQuery.extend = jQuery.fn.extend = function() {
	var src, copyIsArray, copy, name, options, clone,
		target = arguments[0] || {},
		i = 1,
		length = arguments.length,
		deep = false;

	// Handle a deep copy situation
	if ( typeof target === "boolean" ) {
		deep = target;

		// skip the boolean and the target
		target = arguments[ i ] || {};
		i++;
	}

	// Handle case when target is a string or something (possible in deep copy)
	if ( typeof target !== "object" && !jQuery.isFunction(target) ) {
		target = {};
	}

	// extend jQuery itself if only one argument is passed
	if ( i === length ) {
		target = this;
		i--;
	}

	for ( ; i < length; i++ ) {
		// Only deal with non-null/undefined values
		if ( (options = arguments[ i ]) != null ) {
			// Extend the base object
			for ( name in options ) {
				src = target[ name ];
				copy = options[ name ];

				// Prevent never-ending loop
				if ( target === copy ) {
					continue;
				}

				// Recurse if we're merging plain objects or arrays
				if ( deep && copy && ( jQuery.isPlainObject(copy) || (copyIsArray = jQuery.isArray(copy)) ) ) {
					if ( copyIsArray ) {
						copyIsArray = false;
						clone = src && jQuery.isArray(src) ? src : [];

					} else {
						clone = src && jQuery.isPlainObject(src) ? src : {};
					}

					// Never move original objects, clone them
					target[ name ] = jQuery.extend( deep, clone, copy );

				// Don't bring in undefined values
				} else if ( copy !== undefined ) {
					target[ name ] = copy;
				}
			}
		}
	}

	// Return the modified object
	return target;
};

jQuery.extend({
	// Unique for each copy of jQuery on the page
	expando: "jQuery" + ( version + Math.random() ).replace( /\D/g, "" ),

	// Assume jQuery is ready without the ready module
	isReady: true,

	error: function( msg ) {
		throw new Error( msg );
	},

	noop: function() {},

	// See test/unit/core.js for details concerning isFunction.
	// Since version 1.3, DOM methods and functions like alert
	// aren't supported. They return false on IE (#2968).
	isFunction: function( obj ) {
		return jQuery.type(obj) === "function";
	},

	isArray: Array.isArray || function( obj ) {
		return jQuery.type(obj) === "array";
	},

	isWindow: function( obj ) {
		/* jshint eqeqeq: false */
		return obj != null && obj == obj.window;
	},

	isNumeric: function( obj ) {
		// parseFloat NaNs numeric-cast false positives (null|true|false|"")
		// ...but misinterprets leading-number strings, particularly hex literals ("0x...")
		// subtraction forces infinities to NaN
		return obj - parseFloat( obj ) >= 0;
	},

	isEmptyObject: function( obj ) {
		var name;
		for ( name in obj ) {
			return false;
		}
		return true;
	},

	isPlainObject: function( obj ) {
		var key;

		// Must be an Object.
		// Because of IE, we also have to check the presence of the constructor property.
		// Make sure that DOM nodes and window objects don't pass through, as well
		if ( !obj || jQuery.type(obj) !== "object" || obj.nodeType || jQuery.isWindow( obj ) ) {
			return false;
		}

		try {
			// Not own constructor property must be Object
			if ( obj.constructor &&
				!hasOwn.call(obj, "constructor") &&
				!hasOwn.call(obj.constructor.prototype, "isPrototypeOf") ) {
				return false;
			}
		} catch ( e ) {
			// IE8,9 Will throw exceptions on certain host objects #9897
			return false;
		}

		// Support: IE<9
		// Handle iteration over inherited properties before own properties.
		if ( support.ownLast ) {
			for ( key in obj ) {
				return hasOwn.call( obj, key );
			}
		}

		// Own properties are enumerated firstly, so to speed up,
		// if last one is own, then all properties are own.
		for ( key in obj ) {}

		return key === undefined || hasOwn.call( obj, key );
	},

	type: function( obj ) {
		if ( obj == null ) {
			return obj + "";
		}
		return typeof obj === "object" || typeof obj === "function" ?
			class2type[ toString.call(obj) ] || "object" :
			typeof obj;
	},

	// Evaluates a script in a global context
	// Workarounds based on findings by Jim Driscoll
	// http://weblogs.java.net/blog/driscoll/archive/2009/09/08/eval-javascript-global-context
	globalEval: function( data ) {
		if ( data && jQuery.trim( data ) ) {
			// We use execScript on Internet Explorer
			// We use an anonymous function so that context is window
			// rather than jQuery in Firefox
			( window.execScript || function( data ) {
				window[ "eval" ].call( window, data );
			} )( data );
		}
	},

	// Convert dashed to camelCase; used by the css and data modules
	// Microsoft forgot to hump their vendor prefix (#9572)
	camelCase: function( string ) {
		return string.replace( rmsPrefix, "ms-" ).replace( rdashAlpha, fcamelCase );
	},

	nodeName: function( elem, name ) {
		return elem.nodeName && elem.nodeName.toLowerCase() === name.toLowerCase();
	},

	// args is for internal usage only
	each: function( obj, callback, args ) {
		var value,
			i = 0,
			length = obj.length,
			isArray = isArraylike( obj );

		if ( args ) {
			if ( isArray ) {
				for ( ; i < length; i++ ) {
					value = callback.apply( obj[ i ], args );

					if ( value === false ) {
						break;
					}
				}
			} else {
				for ( i in obj ) {
					value = callback.apply( obj[ i ], args );

					if ( value === false ) {
						break;
					}
				}
			}

		// A special, fast, case for the most common use of each
		} else {
			if ( isArray ) {
				for ( ; i < length; i++ ) {
					value = callback.call( obj[ i ], i, obj[ i ] );

					if ( value === false ) {
						break;
					}
				}
			} else {
				for ( i in obj ) {
					value = callback.call( obj[ i ], i, obj[ i ] );

					if ( value === false ) {
						break;
					}
				}
			}
		}

		return obj;
	},

	// Use native String.trim function wherever possible
	trim: trim && !trim.call("\uFEFF\xA0") ?
		function( text ) {
			return text == null ?
				"" :
				trim.call( text );
		} :

		// Otherwise use our own trimming functionality
		function( text ) {
			return text == null ?
				"" :
				( text + "" ).replace( rtrim, "" );
		},

	// results is for internal usage only
	makeArray: function( arr, results ) {
		var ret = results || [];

		if ( arr != null ) {
			if ( isArraylike( Object(arr) ) ) {
				jQuery.merge( ret,
					typeof arr === "string" ?
					[ arr ] : arr
				);
			} else {
				push.call( ret, arr );
			}
		}

		return ret;
	},

	inArray: function( elem, arr, i ) {
		var len;

		if ( arr ) {
			if ( indexOf ) {
				return indexOf.call( arr, elem, i );
			}

			len = arr.length;
			i = i ? i < 0 ? Math.max( 0, len + i ) : i : 0;

			for ( ; i < len; i++ ) {
				// Skip accessing in sparse arrays
				if ( i in arr && arr[ i ] === elem ) {
					return i;
				}
			}
		}

		return -1;
	},

	merge: function( first, second ) {
		var len = +second.length,
			j = 0,
			i = first.length;

		while ( j < len ) {
			first[ i++ ] = second[ j++ ];
		}

		// Support: IE<9
		// Workaround casting of .length to NaN on otherwise arraylike objects (e.g., NodeLists)
		if ( len !== len ) {
			while ( second[j] !== undefined ) {
				first[ i++ ] = second[ j++ ];
			}
		}

		first.length = i;

		return first;
	},

	grep: function( elems, callback, invert ) {
		var callbackInverse,
			matches = [],
			i = 0,
			length = elems.length,
			callbackExpect = !invert;

		// Go through the array, only saving the items
		// that pass the validator function
		for ( ; i < length; i++ ) {
			callbackInverse = !callback( elems[ i ], i );
			if ( callbackInverse !== callbackExpect ) {
				matches.push( elems[ i ] );
			}
		}

		return matches;
	},

	// arg is for internal usage only
	map: function( elems, callback, arg ) {
		var value,
			i = 0,
			length = elems.length,
			isArray = isArraylike( elems ),
			ret = [];

		// Go through the array, translating each of the items to their new values
		if ( isArray ) {
			for ( ; i < length; i++ ) {
				value = callback( elems[ i ], i, arg );

				if ( value != null ) {
					ret.push( value );
				}
			}

		// Go through every key on the object,
		} else {
			for ( i in elems ) {
				value = callback( elems[ i ], i, arg );

				if ( value != null ) {
					ret.push( value );
				}
			}
		}

		// Flatten any nested arrays
		return concat.apply( [], ret );
	},

	// A global GUID counter for objects
	guid: 1,

	// Bind a function to a context, optionally partially applying any
	// arguments.
	proxy: function( fn, context ) {
		var args, proxy, tmp;

		if ( typeof context === "string" ) {
			tmp = fn[ context ];
			context = fn;
			fn = tmp;
		}

		// Quick check to determine if target is callable, in the spec
		// this throws a TypeError, but we will just return undefined.
		if ( !jQuery.isFunction( fn ) ) {
			return undefined;
		}

		// Simulated bind
		args = slice.call( arguments, 2 );
		proxy = function() {
			return fn.apply( context || this, args.concat( slice.call( arguments ) ) );
		};

		// Set the guid of unique handler to the same of original handler, so it can be removed
		proxy.guid = fn.guid = fn.guid || jQuery.guid++;

		return proxy;
	},

	now: function() {
		return +( new Date() );
	},

	// jQuery.support is not used in Core but other projects attach their
	// properties to it so it needs to exist.
	support: support
});

// Populate the class2type map
jQuery.each("Boolean Number String Function Array Date RegExp Object Error".split(" "), function(i, name) {
	class2type[ "[object " + name + "]" ] = name.toLowerCase();
});

function isArraylike( obj ) {
	var length = obj.length,
		type = jQuery.type( obj );

	if ( type === "function" || jQuery.isWindow( obj ) ) {
		return false;
	}

	if ( obj.nodeType === 1 && length ) {
		return true;
	}

	return type === "array" || length === 0 ||
		typeof length === "number" && length > 0 && ( length - 1 ) in obj;
}
var Sizzle =
/*!
 * Sizzle CSS Selector Engine v1.10.16
 * http://sizzlejs.com/
 *
 * Copyright 2013 jQuery Foundation, Inc. and other contributors
 * Released under the MIT license
 * http://jquery.org/license
 *
 * Date: 2014-01-13
 */
(function( window ) {

var i,
	support,
	Expr,
	getText,
	isXML,
	compile,
	outermostContext,
	sortInput,
	hasDuplicate,

	// Local document vars
	setDocument,
	document,
	docElem,
	documentIsHTML,
	rbuggyQSA,
	rbuggyMatches,
	matches,
	contains,

	// Instance-specific data
	expando = "sizzle" + -(new Date()),
	preferredDoc = window.document,
	dirruns = 0,
	done = 0,
	classCache = createCache(),
	tokenCache = createCache(),
	compilerCache = createCache(),
	sortOrder = function( a, b ) {
		if ( a === b ) {
			hasDuplicate = true;
		}
		return 0;
	},

	// General-purpose constants
	strundefined = typeof undefined,
	MAX_NEGATIVE = 1 << 31,

	// Instance methods
	hasOwn = ({}).hasOwnProperty,
	arr = [],
	pop = arr.pop,
	push_native = arr.push,
	push = arr.push,
	slice = arr.slice,
	// Use a stripped-down indexOf if we can't use a native one
	indexOf = arr.indexOf || function( elem ) {
		var i = 0,
			len = this.length;
		for ( ; i < len; i++ ) {
			if ( this[i] === elem ) {
				return i;
			}
		}
		return -1;
	},

	booleans = "checked|selected|async|autofocus|autoplay|controls|defer|disabled|hidden|ismap|loop|multiple|open|readonly|required|scoped",

	// Regular expressions

	// Whitespace characters http://www.w3.org/TR/css3-selectors/#whitespace
	whitespace = "[\\x20\\t\\r\\n\\f]",
	// http://www.w3.org/TR/css3-syntax/#characters
	characterEncoding = "(?:\\\\.|[\\w-]|[^\\x00-\\xa0])+",

	// Loosely modeled on CSS identifier characters
	// An unquoted value should be a CSS identifier http://www.w3.org/TR/css3-selectors/#attribute-selectors
	// Proper syntax: http://www.w3.org/TR/CSS21/syndata.html#value-def-identifier
	identifier = characterEncoding.replace( "w", "w#" ),

	// Acceptable operators http://www.w3.org/TR/selectors/#attribute-selectors
	attributes = "\\[" + whitespace + "*(" + characterEncoding + ")" + whitespace +
		"*(?:([*^$|!~]?=)" + whitespace + "*(?:(['\"])((?:\\\\.|[^\\\\])*?)\\3|(" + identifier + ")|)|)" + whitespace + "*\\]",

	// Prefer arguments quoted,
	//   then not containing pseudos/brackets,
	//   then attribute selectors/non-parenthetical expressions,
	//   then anything else
	// These preferences are here to reduce the number of selectors
	//   needing tokenize in the PSEUDO preFilter
	pseudos = ":(" + characterEncoding + ")(?:\\(((['\"])((?:\\\\.|[^\\\\])*?)\\3|((?:\\\\.|[^\\\\()[\\]]|" + attributes.replace( 3, 8 ) + ")*)|.*)\\)|)",

	// Leading and non-escaped trailing whitespace, capturing some non-whitespace characters preceding the latter
	rtrim = new RegExp( "^" + whitespace + "+|((?:^|[^\\\\])(?:\\\\.)*)" + whitespace + "+$", "g" ),

	rcomma = new RegExp( "^" + whitespace + "*," + whitespace + "*" ),
	rcombinators = new RegExp( "^" + whitespace + "*([>+~]|" + whitespace + ")" + whitespace + "*" ),

	rattributeQuotes = new RegExp( "=" + whitespace + "*([^\\]'\"]*?)" + whitespace + "*\\]", "g" ),

	rpseudo = new RegExp( pseudos ),
	ridentifier = new RegExp( "^" + identifier + "$" ),

	matchExpr = {
		"ID": new RegExp( "^#(" + characterEncoding + ")" ),
		"CLASS": new RegExp( "^\\.(" + characterEncoding + ")" ),
		"TAG": new RegExp( "^(" + characterEncoding.replace( "w", "w*" ) + ")" ),
		"ATTR": new RegExp( "^" + attributes ),
		"PSEUDO": new RegExp( "^" + pseudos ),
		"CHILD": new RegExp( "^:(only|first|last|nth|nth-last)-(child|of-type)(?:\\(" + whitespace +
			"*(even|odd|(([+-]|)(\\d*)n|)" + whitespace + "*(?:([+-]|)" + whitespace +
			"*(\\d+)|))" + whitespace + "*\\)|)", "i" ),
		"bool": new RegExp( "^(?:" + booleans + ")$", "i" ),
		// For use in libraries implementing .is()
		// We use this for POS matching in `select`
		"needsContext": new RegExp( "^" + whitespace + "*[>+~]|:(even|odd|eq|gt|lt|nth|first|last)(?:\\(" +
			whitespace + "*((?:-\\d)?\\d*)" + whitespace + "*\\)|)(?=[^-]|$)", "i" )
	},

	rinputs = /^(?:input|select|textarea|button)$/i,
	rheader = /^h\d$/i,

	rnative = /^[^{]+\{\s*\[native \w/,

	// Easily-parseable/retrievable ID or TAG or CLASS selectors
	rquickExpr = /^(?:#([\w-]+)|(\w+)|\.([\w-]+))$/,

	rsibling = /[+~]/,
	rescape = /'|\\/g,

	// CSS escapes http://www.w3.org/TR/CSS21/syndata.html#escaped-characters
	runescape = new RegExp( "\\\\([\\da-f]{1,6}" + whitespace + "?|(" + whitespace + ")|.)", "ig" ),
	funescape = function( _, escaped, escapedWhitespace ) {
		var high = "0x" + escaped - 0x10000;
		// NaN means non-codepoint
		// Support: Firefox
		// Workaround erroneous numeric interpretation of +"0x"
		return high !== high || escapedWhitespace ?
			escaped :
			high < 0 ?
				// BMP codepoint
				String.fromCharCode( high + 0x10000 ) :
				// Supplemental Plane codepoint (surrogate pair)
				String.fromCharCode( high >> 10 | 0xD800, high & 0x3FF | 0xDC00 );
	};

// Optimize for push.apply( _, NodeList )
try {
	push.apply(
		(arr = slice.call( preferredDoc.childNodes )),
		preferredDoc.childNodes
	);
	// Support: Android<4.0
	// Detect silently failing push.apply
	arr[ preferredDoc.childNodes.length ].nodeType;
} catch ( e ) {
	push = { apply: arr.length ?

		// Leverage slice if possible
		function( target, els ) {
			push_native.apply( target, slice.call(els) );
		} :

		// Support: IE<9
		// Otherwise append directly
		function( target, els ) {
			var j = target.length,
				i = 0;
			// Can't trust NodeList.length
			while ( (target[j++] = els[i++]) ) {}
			target.length = j - 1;
		}
	};
}

function Sizzle( selector, context, results, seed ) {
	var match, elem, m, nodeType,
		// QSA vars
		i, groups, old, nid, newContext, newSelector;

	if ( ( context ? context.ownerDocument || context : preferredDoc ) !== document ) {
		setDocument( context );
	}

	context = context || document;
	results = results || [];

	if ( !selector || typeof selector !== "string" ) {
		return results;
	}

	if ( (nodeType = context.nodeType) !== 1 && nodeType !== 9 ) {
		return [];
	}

	if ( documentIsHTML && !seed ) {

		// Shortcuts
		if ( (match = rquickExpr.exec( selector )) ) {
			// Speed-up: Sizzle("#ID")
			if ( (m = match[1]) ) {
				if ( nodeType === 9 ) {
					elem = context.getElementById( m );
					// Check parentNode to catch when Blackberry 4.6 returns
					// nodes that are no longer in the document (jQuery #6963)
					if ( elem && elem.parentNode ) {
						// Handle the case where IE, Opera, and Webkit return items
						// by name instead of ID
						if ( elem.id === m ) {
							results.push( elem );
							return results;
						}
					} else {
						return results;
					}
				} else {
					// Context is not a document
					if ( context.ownerDocument && (elem = context.ownerDocument.getElementById( m )) &&
						contains( context, elem ) && elem.id === m ) {
						results.push( elem );
						return results;
					}
				}

			// Speed-up: Sizzle("TAG")
			} else if ( match[2] ) {
				push.apply( results, context.getElementsByTagName( selector ) );
				return results;

			// Speed-up: Sizzle(".CLASS")
			} else if ( (m = match[3]) && support.getElementsByClassName && context.getElementsByClassName ) {
				push.apply( results, context.getElementsByClassName( m ) );
				return results;
			}
		}

		// QSA path
		if ( support.qsa && (!rbuggyQSA || !rbuggyQSA.test( selector )) ) {
			nid = old = expando;
			newContext = context;
			newSelector = nodeType === 9 && selector;

			// qSA works strangely on Element-rooted queries
			// We can work around this by specifying an extra ID on the root
			// and working up from there (Thanks to Andrew Dupont for the technique)
			// IE 8 doesn't work on object elements
			if ( nodeType === 1 && context.nodeName.toLowerCase() !== "object" ) {
				groups = tokenize( selector );

				if ( (old = context.getAttribute("id")) ) {
					nid = old.replace( rescape, "\\$&" );
				} else {
					context.setAttribute( "id", nid );
				}
				nid = "[id='" + nid + "'] ";

				i = groups.length;
				while ( i-- ) {
					groups[i] = nid + toSelector( groups[i] );
				}
				newContext = rsibling.test( selector ) && testContext( context.parentNode ) || context;
				newSelector = groups.join(",");
			}

			if ( newSelector ) {
				try {
					push.apply( results,
						newContext.querySelectorAll( newSelector )
					);
					return results;
				} catch(qsaError) {
				} finally {
					if ( !old ) {
						context.removeAttribute("id");
					}
				}
			}
		}
	}

	// All others
	return select( selector.replace( rtrim, "$1" ), context, results, seed );
}

/**
 * Create key-value caches of limited size
 * @returns {Function(string, Object)} Returns the Object data after storing it on itself with
 *	property name the (space-suffixed) string and (if the cache is larger than Expr.cacheLength)
 *	deleting the oldest entry
 */
function createCache() {
	var keys = [];

	function cache( key, value ) {
		// Use (key + " ") to avoid collision with native prototype properties (see Issue #157)
		if ( keys.push( key + " " ) > Expr.cacheLength ) {
			// Only keep the most recent entries
			delete cache[ keys.shift() ];
		}
		return (cache[ key + " " ] = value);
	}
	return cache;
}

/**
 * Mark a function for special use by Sizzle
 * @param {Function} fn The function to mark
 */
function markFunction( fn ) {
	fn[ expando ] = true;
	return fn;
}

/**
 * Support testing using an element
 * @param {Function} fn Passed the created div and expects a boolean result
 */
function assert( fn ) {
	var div = document.createElement("div");

	try {
		return !!fn( div );
	} catch (e) {
		return false;
	} finally {
		// Remove from its parent by default
		if ( div.parentNode ) {
			div.parentNode.removeChild( div );
		}
		// release memory in IE
		div = null;
	}
}

/**
 * Adds the same handler for all of the specified attrs
 * @param {String} attrs Pipe-separated list of attributes
 * @param {Function} handler The method that will be applied
 */
function addHandle( attrs, handler ) {
	var arr = attrs.split("|"),
		i = attrs.length;

	while ( i-- ) {
		Expr.attrHandle[ arr[i] ] = handler;
	}
}

/**
 * Checks document order of two siblings
 * @param {Element} a
 * @param {Element} b
 * @returns {Number} Returns less than 0 if a precedes b, greater than 0 if a follows b
 */
function siblingCheck( a, b ) {
	var cur = b && a,
		diff = cur && a.nodeType === 1 && b.nodeType === 1 &&
			( ~b.sourceIndex || MAX_NEGATIVE ) -
			( ~a.sourceIndex || MAX_NEGATIVE );

	// Use IE sourceIndex if available on both nodes
	if ( diff ) {
		return diff;
	}

	// Check if b follows a
	if ( cur ) {
		while ( (cur = cur.nextSibling) ) {
			if ( cur === b ) {
				return -1;
			}
		}
	}

	return a ? 1 : -1;
}

/**
 * Returns a function to use in pseudos for input types
 * @param {String} type
 */
function createInputPseudo( type ) {
	return function( elem ) {
		var name = elem.nodeName.toLowerCase();
		return name === "input" && elem.type === type;
	};
}

/**
 * Returns a function to use in pseudos for buttons
 * @param {String} type
 */
function createButtonPseudo( type ) {
	return function( elem ) {
		var name = elem.nodeName.toLowerCase();
		return (name === "input" || name === "button") && elem.type === type;
	};
}

/**
 * Returns a function to use in pseudos for positionals
 * @param {Function} fn
 */
function createPositionalPseudo( fn ) {
	return markFunction(function( argument ) {
		argument = +argument;
		return markFunction(function( seed, matches ) {
			var j,
				matchIndexes = fn( [], seed.length, argument ),
				i = matchIndexes.length;

			// Match elements found at the specified indexes
			while ( i-- ) {
				if ( seed[ (j = matchIndexes[i]) ] ) {
					seed[j] = !(matches[j] = seed[j]);
				}
			}
		});
	});
}

/**
 * Checks a node for validity as a Sizzle context
 * @param {Element|Object=} context
 * @returns {Element|Object|Boolean} The input node if acceptable, otherwise a falsy value
 */
function testContext( context ) {
	return context && typeof context.getElementsByTagName !== strundefined && context;
}

// Expose support vars for convenience
support = Sizzle.support = {};

/**
 * Detects XML nodes
 * @param {Element|Object} elem An element or a document
 * @returns {Boolean} True iff elem is a non-HTML XML node
 */
isXML = Sizzle.isXML = function( elem ) {
	// documentElement is verified for cases where it doesn't yet exist
	// (such as loading iframes in IE - #4833)
	var documentElement = elem && (elem.ownerDocument || elem).documentElement;
	return documentElement ? documentElement.nodeName !== "HTML" : false;
};

/**
 * Sets document-related variables once based on the current document
 * @param {Element|Object} [doc] An element or document object to use to set the document
 * @returns {Object} Returns the current document
 */
setDocument = Sizzle.setDocument = function( node ) {
	var hasCompare,
		doc = node ? node.ownerDocument || node : preferredDoc,
		parent = doc.defaultView;

	// If no document and documentElement is available, return
	if ( doc === document || doc.nodeType !== 9 || !doc.documentElement ) {
		return document;
	}

	// Set our document
	document = doc;
	docElem = doc.documentElement;

	// Support tests
	documentIsHTML = !isXML( doc );

	// Support: IE>8
	// If iframe document is assigned to "document" variable and if iframe has been reloaded,
	// IE will throw "permission denied" error when accessing "document" variable, see jQuery #13936
	// IE6-8 do not support the defaultView property so parent will be undefined
	if ( parent && parent !== parent.top ) {
		// IE11 does not have attachEvent, so all must suffer
		if ( parent.addEventListener ) {
			parent.addEventListener( "unload", function() {
				setDocument();
			}, false );
		} else if ( parent.attachEvent ) {
			parent.attachEvent( "onunload", function() {
				setDocument();
			});
		}
	}

	/* Attributes
	---------------------------------------------------------------------- */

	// Support: IE<8
	// Verify that getAttribute really returns attributes and not properties (excepting IE8 booleans)
	support.attributes = assert(function( div ) {
		div.className = "i";
		return !div.getAttribute("className");
	});

	/* getElement(s)By*
	---------------------------------------------------------------------- */

	// Check if getElementsByTagName("*") returns only elements
	support.getElementsByTagName = assert(function( div ) {
		div.appendChild( doc.createComment("") );
		return !div.getElementsByTagName("*").length;
	});

	// Check if getElementsByClassName can be trusted
	support.getElementsByClassName = rnative.test( doc.getElementsByClassName ) && assert(function( div ) {
		div.innerHTML = "<div class='a'></div><div class='a i'></div>";

		// Support: Safari<4
		// Catch class over-caching
		div.firstChild.className = "i";
		// Support: Opera<10
		// Catch gEBCN failure to find non-leading classes
		return div.getElementsByClassName("i").length === 2;
	});

	// Support: IE<10
	// Check if getElementById returns elements by name
	// The broken getElementById methods don't pick up programatically-set names,
	// so use a roundabout getElementsByName test
	support.getById = assert(function( div ) {
		docElem.appendChild( div ).id = expando;
		return !doc.getElementsByName || !doc.getElementsByName( expando ).length;
	});

	// ID find and filter
	if ( support.getById ) {
		Expr.find["ID"] = function( id, context ) {
			if ( typeof context.getElementById !== strundefined && documentIsHTML ) {
				var m = context.getElementById( id );
				// Check parentNode to catch when Blackberry 4.6 returns
				// nodes that are no longer in the document #6963
				return m && m.parentNode ? [m] : [];
			}
		};
		Expr.filter["ID"] = function( id ) {
			var attrId = id.replace( runescape, funescape );
			return function( elem ) {
				return elem.getAttribute("id") === attrId;
			};
		};
	} else {
		// Support: IE6/7
		// getElementById is not reliable as a find shortcut
		delete Expr.find["ID"];

		Expr.filter["ID"] =  function( id ) {
			var attrId = id.replace( runescape, funescape );
			return function( elem ) {
				var node = typeof elem.getAttributeNode !== strundefined && elem.getAttributeNode("id");
				return node && node.value === attrId;
			};
		};
	}

	// Tag
	Expr.find["TAG"] = support.getElementsByTagName ?
		function( tag, context ) {
			if ( typeof context.getElementsByTagName !== strundefined ) {
				return context.getElementsByTagName( tag );
			}
		} :
		function( tag, context ) {
			var elem,
				tmp = [],
				i = 0,
				results = context.getElementsByTagName( tag );

			// Filter out possible comments
			if ( tag === "*" ) {
				while ( (elem = results[i++]) ) {
					if ( elem.nodeType === 1 ) {
						tmp.push( elem );
					}
				}

				return tmp;
			}
			return results;
		};

	// Class
	Expr.find["CLASS"] = support.getElementsByClassName && function( className, context ) {
		if ( typeof context.getElementsByClassName !== strundefined && documentIsHTML ) {
			return context.getElementsByClassName( className );
		}
	};

	/* QSA/matchesSelector
	---------------------------------------------------------------------- */

	// QSA and matchesSelector support

	// matchesSelector(:active) reports false when true (IE9/Opera 11.5)
	rbuggyMatches = [];

	// qSa(:focus) reports false when true (Chrome 21)
	// We allow this because of a bug in IE8/9 that throws an error
	// whenever `document.activeElement` is accessed on an iframe
	// So, we allow :focus to pass through QSA all the time to avoid the IE error
	// See http://bugs.jquery.com/ticket/13378
	rbuggyQSA = [];

	if ( (support.qsa = rnative.test( doc.querySelectorAll )) ) {
		// Build QSA regex
		// Regex strategy adopted from Diego Perini
		assert(function( div ) {
			// Select is set to empty string on purpose
			// This is to test IE's treatment of not explicitly
			// setting a boolean content attribute,
			// since its presence should be enough
			// http://bugs.jquery.com/ticket/12359
			div.innerHTML = "<select t=''><option selected=''></option></select>";

			// Support: IE8, Opera 10-12
			// Nothing should be selected when empty strings follow ^= or $= or *=
			if ( div.querySelectorAll("[t^='']").length ) {
				rbuggyQSA.push( "[*^$]=" + whitespace + "*(?:''|\"\")" );
			}

			// Support: IE8
			// Boolean attributes and "value" are not treated correctly
			if ( !div.querySelectorAll("[selected]").length ) {
				rbuggyQSA.push( "\\[" + whitespace + "*(?:value|" + booleans + ")" );
			}

			// Webkit/Opera - :checked should return selected option elements
			// http://www.w3.org/TR/2011/REC-css3-selectors-20110929/#checked
			// IE8 throws error here and will not see later tests
			if ( !div.querySelectorAll(":checked").length ) {
				rbuggyQSA.push(":checked");
			}
		});

		assert(function( div ) {
			// Support: Windows 8 Native Apps
			// The type and name attributes are restricted during .innerHTML assignment
			var input = doc.createElement("input");
			input.setAttribute( "type", "hidden" );
			div.appendChild( input ).setAttribute( "name", "D" );

			// Support: IE8
			// Enforce case-sensitivity of name attribute
			if ( div.querySelectorAll("[name=d]").length ) {
				rbuggyQSA.push( "name" + whitespace + "*[*^$|!~]?=" );
			}

			// FF 3.5 - :enabled/:disabled and hidden elements (hidden elements are still enabled)
			// IE8 throws error here and will not see later tests
			if ( !div.querySelectorAll(":enabled").length ) {
				rbuggyQSA.push( ":enabled", ":disabled" );
			}

			// Opera 10-11 does not throw on post-comma invalid pseudos
			div.querySelectorAll("*,:x");
			rbuggyQSA.push(",.*:");
		});
	}

	if ( (support.matchesSelector = rnative.test( (matches = docElem.webkitMatchesSelector ||
		docElem.mozMatchesSelector ||
		docElem.oMatchesSelector ||
		docElem.msMatchesSelector) )) ) {

		assert(function( div ) {
			// Check to see if it's possible to do matchesSelector
			// on a disconnected node (IE 9)
			support.disconnectedMatch = matches.call( div, "div" );

			// This should fail with an exception
			// Gecko does not error, returns false instead
			matches.call( div, "[s!='']:x" );
			rbuggyMatches.push( "!=", pseudos );
		});
	}

	rbuggyQSA = rbuggyQSA.length && new RegExp( rbuggyQSA.join("|") );
	rbuggyMatches = rbuggyMatches.length && new RegExp( rbuggyMatches.join("|") );

	/* Contains
	---------------------------------------------------------------------- */
	hasCompare = rnative.test( docElem.compareDocumentPosition );

	// Element contains another
	// Purposefully does not implement inclusive descendent
	// As in, an element does not contain itself
	contains = hasCompare || rnative.test( docElem.contains ) ?
		function( a, b ) {
			var adown = a.nodeType === 9 ? a.documentElement : a,
				bup = b && b.parentNode;
			return a === bup || !!( bup && bup.nodeType === 1 && (
				adown.contains ?
					adown.contains( bup ) :
					a.compareDocumentPosition && a.compareDocumentPosition( bup ) & 16
			));
		} :
		function( a, b ) {
			if ( b ) {
				while ( (b = b.parentNode) ) {
					if ( b === a ) {
						return true;
					}
				}
			}
			return false;
		};

	/* Sorting
	---------------------------------------------------------------------- */

	// Document order sorting
	sortOrder = hasCompare ?
	function( a, b ) {

		// Flag for duplicate removal
		if ( a === b ) {
			hasDuplicate = true;
			return 0;
		}

		// Sort on method existence if only one input has compareDocumentPosition
		var compare = !a.compareDocumentPosition - !b.compareDocumentPosition;
		if ( compare ) {
			return compare;
		}

		// Calculate position if both inputs belong to the same document
		compare = ( a.ownerDocument || a ) === ( b.ownerDocument || b ) ?
			a.compareDocumentPosition( b ) :

			// Otherwise we know they are disconnected
			1;

		// Disconnected nodes
		if ( compare & 1 ||
			(!support.sortDetached && b.compareDocumentPosition( a ) === compare) ) {

			// Choose the first element that is related to our preferred document
			if ( a === doc || a.ownerDocument === preferredDoc && contains(preferredDoc, a) ) {
				return -1;
			}
			if ( b === doc || b.ownerDocument === preferredDoc && contains(preferredDoc, b) ) {
				return 1;
			}

			// Maintain original order
			return sortInput ?
				( indexOf.call( sortInput, a ) - indexOf.call( sortInput, b ) ) :
				0;
		}

		return compare & 4 ? -1 : 1;
	} :
	function( a, b ) {
		// Exit early if the nodes are identical
		if ( a === b ) {
			hasDuplicate = true;
			return 0;
		}

		var cur,
			i = 0,
			aup = a.parentNode,
			bup = b.parentNode,
			ap = [ a ],
			bp = [ b ];

		// Parentless nodes are either documents or disconnected
		if ( !aup || !bup ) {
			return a === doc ? -1 :
				b === doc ? 1 :
				aup ? -1 :
				bup ? 1 :
				sortInput ?
				( indexOf.call( sortInput, a ) - indexOf.call( sortInput, b ) ) :
				0;

		// If the nodes are siblings, we can do a quick check
		} else if ( aup === bup ) {
			return siblingCheck( a, b );
		}

		// Otherwise we need full lists of their ancestors for comparison
		cur = a;
		while ( (cur = cur.parentNode) ) {
			ap.unshift( cur );
		}
		cur = b;
		while ( (cur = cur.parentNode) ) {
			bp.unshift( cur );
		}

		// Walk down the tree looking for a discrepancy
		while ( ap[i] === bp[i] ) {
			i++;
		}

		return i ?
			// Do a sibling check if the nodes have a common ancestor
			siblingCheck( ap[i], bp[i] ) :

			// Otherwise nodes in our document sort first
			ap[i] === preferredDoc ? -1 :
			bp[i] === preferredDoc ? 1 :
			0;
	};

	return doc;
};

Sizzle.matches = function( expr, elements ) {
	return Sizzle( expr, null, null, elements );
};

Sizzle.matchesSelector = function( elem, expr ) {
	// Set document vars if needed
	if ( ( elem.ownerDocument || elem ) !== document ) {
		setDocument( elem );
	}

	// Make sure that attribute selectors are quoted
	expr = expr.replace( rattributeQuotes, "='$1']" );

	if ( support.matchesSelector && documentIsHTML &&
		( !rbuggyMatches || !rbuggyMatches.test( expr ) ) &&
		( !rbuggyQSA     || !rbuggyQSA.test( expr ) ) ) {

		try {
			var ret = matches.call( elem, expr );

			// IE 9's matchesSelector returns false on disconnected nodes
			if ( ret || support.disconnectedMatch ||
					// As well, disconnected nodes are said to be in a document
					// fragment in IE 9
					elem.document && elem.document.nodeType !== 11 ) {
				return ret;
			}
		} catch(e) {}
	}

	return Sizzle( expr, document, null, [elem] ).length > 0;
};

Sizzle.contains = function( context, elem ) {
	// Set document vars if needed
	if ( ( context.ownerDocument || context ) !== document ) {
		setDocument( context );
	}
	return contains( context, elem );
};

Sizzle.attr = function( elem, name ) {
	// Set document vars if needed
	if ( ( elem.ownerDocument || elem ) !== document ) {
		setDocument( elem );
	}

	var fn = Expr.attrHandle[ name.toLowerCase() ],
		// Don't get fooled by Object.prototype properties (jQuery #13807)
		val = fn && hasOwn.call( Expr.attrHandle, name.toLowerCase() ) ?
			fn( elem, name, !documentIsHTML ) :
			undefined;

	return val !== undefined ?
		val :
		support.attributes || !documentIsHTML ?
			elem.getAttribute( name ) :
			(val = elem.getAttributeNode(name)) && val.specified ?
				val.value :
				null;
};

Sizzle.error = function( msg ) {
	throw new Error( "Syntax error, unrecognized expression: " + msg );
};

/**
 * Document sorting and removing duplicates
 * @param {ArrayLike} results
 */
Sizzle.uniqueSort = function( results ) {
	var elem,
		duplicates = [],
		j = 0,
		i = 0;

	// Unless we *know* we can detect duplicates, assume their presence
	hasDuplicate = !support.detectDuplicates;
	sortInput = !support.sortStable && results.slice( 0 );
	results.sort( sortOrder );

	if ( hasDuplicate ) {
		while ( (elem = results[i++]) ) {
			if ( elem === results[ i ] ) {
				j = duplicates.push( i );
			}
		}
		while ( j-- ) {
			results.splice( duplicates[ j ], 1 );
		}
	}

	// Clear input after sorting to release objects
	// See https://github.com/jquery/sizzle/pull/225
	sortInput = null;

	return results;
};

/**
 * Utility function for retrieving the text value of an array of DOM nodes
 * @param {Array|Element} elem
 */
getText = Sizzle.getText = function( elem ) {
	var node,
		ret = "",
		i = 0,
		nodeType = elem.nodeType;

	if ( !nodeType ) {
		// If no nodeType, this is expected to be an array
		while ( (node = elem[i++]) ) {
			// Do not traverse comment nodes
			ret += getText( node );
		}
	} else if ( nodeType === 1 || nodeType === 9 || nodeType === 11 ) {
		// Use textContent for elements
		// innerText usage removed for consistency of new lines (jQuery #11153)
		if ( typeof elem.textContent === "string" ) {
			return elem.textContent;
		} else {
			// Traverse its children
			for ( elem = elem.firstChild; elem; elem = elem.nextSibling ) {
				ret += getText( elem );
			}
		}
	} else if ( nodeType === 3 || nodeType === 4 ) {
		return elem.nodeValue;
	}
	// Do not include comment or processing instruction nodes

	return ret;
};

Expr = Sizzle.selectors = {

	// Can be adjusted by the user
	cacheLength: 50,

	createPseudo: markFunction,

	match: matchExpr,

	attrHandle: {},

	find: {},

	relative: {
		">": { dir: "parentNode", first: true },
		" ": { dir: "parentNode" },
		"+": { dir: "previousSibling", first: true },
		"~": { dir: "previousSibling" }
	},

	preFilter: {
		"ATTR": function( match ) {
			match[1] = match[1].replace( runescape, funescape );

			// Move the given value to match[3] whether quoted or unquoted
			match[3] = ( match[4] || match[5] || "" ).replace( runescape, funescape );

			if ( match[2] === "~=" ) {
				match[3] = " " + match[3] + " ";
			}

			return match.slice( 0, 4 );
		},

		"CHILD": function( match ) {
			/* matches from matchExpr["CHILD"]
				1 type (only|nth|...)
				2 what (child|of-type)
				3 argument (even|odd|\d*|\d*n([+-]\d+)?|...)
				4 xn-component of xn+y argument ([+-]?\d*n|)
				5 sign of xn-component
				6 x of xn-component
				7 sign of y-component
				8 y of y-component
			*/
			match[1] = match[1].toLowerCase();

			if ( match[1].slice( 0, 3 ) === "nth" ) {
				// nth-* requires argument
				if ( !match[3] ) {
					Sizzle.error( match[0] );
				}

				// numeric x and y parameters for Expr.filter.CHILD
				// remember that false/true cast respectively to 0/1
				match[4] = +( match[4] ? match[5] + (match[6] || 1) : 2 * ( match[3] === "even" || match[3] === "odd" ) );
				match[5] = +( ( match[7] + match[8] ) || match[3] === "odd" );

			// other types prohibit arguments
			} else if ( match[3] ) {
				Sizzle.error( match[0] );
			}

			return match;
		},

		"PSEUDO": function( match ) {
			var excess,
				unquoted = !match[5] && match[2];

			if ( matchExpr["CHILD"].test( match[0] ) ) {
				return null;
			}

			// Accept quoted arguments as-is
			if ( match[3] && match[4] !== undefined ) {
				match[2] = match[4];

			// Strip excess characters from unquoted arguments
			} else if ( unquoted && rpseudo.test( unquoted ) &&
				// Get excess from tokenize (recursively)
				(excess = tokenize( unquoted, true )) &&
				// advance to the next closing parenthesis
				(excess = unquoted.indexOf( ")", unquoted.length - excess ) - unquoted.length) ) {

				// excess is a negative index
				match[0] = match[0].slice( 0, excess );
				match[2] = unquoted.slice( 0, excess );
			}

			// Return only captures needed by the pseudo filter method (type and argument)
			return match.slice( 0, 3 );
		}
	},

	filter: {

		"TAG": function( nodeNameSelector ) {
			var nodeName = nodeNameSelector.replace( runescape, funescape ).toLowerCase();
			return nodeNameSelector === "*" ?
				function() { return true; } :
				function( elem ) {
					return elem.nodeName && elem.nodeName.toLowerCase() === nodeName;
				};
		},

		"CLASS": function( className ) {
			var pattern = classCache[ className + " " ];

			return pattern ||
				(pattern = new RegExp( "(^|" + whitespace + ")" + className + "(" + whitespace + "|$)" )) &&
				classCache( className, function( elem ) {
					return pattern.test( typeof elem.className === "string" && elem.className || typeof elem.getAttribute !== strundefined && elem.getAttribute("class") || "" );
				});
		},

		"ATTR": function( name, operator, check ) {
			return function( elem ) {
				var result = Sizzle.attr( elem, name );

				if ( result == null ) {
					return operator === "!=";
				}
				if ( !operator ) {
					return true;
				}

				result += "";

				return operator === "=" ? result === check :
					operator === "!=" ? result !== check :
					operator === "^=" ? check && result.indexOf( check ) === 0 :
					operator === "*=" ? check && result.indexOf( check ) > -1 :
					operator === "$=" ? check && result.slice( -check.length ) === check :
					operator === "~=" ? ( " " + result + " " ).indexOf( check ) > -1 :
					operator === "|=" ? result === check || result.slice( 0, check.length + 1 ) === check + "-" :
					false;
			};
		},

		"CHILD": function( type, what, argument, first, last ) {
			var simple = type.slice( 0, 3 ) !== "nth",
				forward = type.slice( -4 ) !== "last",
				ofType = what === "of-type";

			return first === 1 && last === 0 ?

				// Shortcut for :nth-*(n)
				function( elem ) {
					return !!elem.parentNode;
				} :

				function( elem, context, xml ) {
					var cache, outerCache, node, diff, nodeIndex, start,
						dir = simple !== forward ? "nextSibling" : "previousSibling",
						parent = elem.parentNode,
						name = ofType && elem.nodeName.toLowerCase(),
						useCache = !xml && !ofType;

					if ( parent ) {

						// :(first|last|only)-(child|of-type)
						if ( simple ) {
							while ( dir ) {
								node = elem;
								while ( (node = node[ dir ]) ) {
									if ( ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1 ) {
										return false;
									}
								}
								// Reverse direction for :only-* (if we haven't yet done so)
								start = dir = type === "only" && !start && "nextSibling";
							}
							return true;
						}

						start = [ forward ? parent.firstChild : parent.lastChild ];

						// non-xml :nth-child(...) stores cache data on `parent`
						if ( forward && useCache ) {
							// Seek `elem` from a previously-cached index
							outerCache = parent[ expando ] || (parent[ expando ] = {});
							cache = outerCache[ type ] || [];
							nodeIndex = cache[0] === dirruns && cache[1];
							diff = cache[0] === dirruns && cache[2];
							node = nodeIndex && parent.childNodes[ nodeIndex ];

							while ( (node = ++nodeIndex && node && node[ dir ] ||

								// Fallback to seeking `elem` from the start
								(diff = nodeIndex = 0) || start.pop()) ) {

								// When found, cache indexes on `parent` and break
								if ( node.nodeType === 1 && ++diff && node === elem ) {
									outerCache[ type ] = [ dirruns, nodeIndex, diff ];
									break;
								}
							}

						// Use previously-cached element index if available
						} else if ( useCache && (cache = (elem[ expando ] || (elem[ expando ] = {}))[ type ]) && cache[0] === dirruns ) {
							diff = cache[1];

						// xml :nth-child(...) or :nth-last-child(...) or :nth(-last)?-of-type(...)
						} else {
							// Use the same loop as above to seek `elem` from the start
							while ( (node = ++nodeIndex && node && node[ dir ] ||
								(diff = nodeIndex = 0) || start.pop()) ) {

								if ( ( ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1 ) && ++diff ) {
									// Cache the index of each encountered element
									if ( useCache ) {
										(node[ expando ] || (node[ expando ] = {}))[ type ] = [ dirruns, diff ];
									}

									if ( node === elem ) {
										break;
									}
								}
							}
						}

						// Incorporate the offset, then check against cycle size
						diff -= last;
						return diff === first || ( diff % first === 0 && diff / first >= 0 );
					}
				};
		},

		"PSEUDO": function( pseudo, argument ) {
			// pseudo-class names are case-insensitive
			// http://www.w3.org/TR/selectors/#pseudo-classes
			// Prioritize by case sensitivity in case custom pseudos are added with uppercase letters
			// Remember that setFilters inherits from pseudos
			var args,
				fn = Expr.pseudos[ pseudo ] || Expr.setFilters[ pseudo.toLowerCase() ] ||
					Sizzle.error( "unsupported pseudo: " + pseudo );

			// The user may use createPseudo to indicate that
			// arguments are needed to create the filter function
			// just as Sizzle does
			if ( fn[ expando ] ) {
				return fn( argument );
			}

			// But maintain support for old signatures
			if ( fn.length > 1 ) {
				args = [ pseudo, pseudo, "", argument ];
				return Expr.setFilters.hasOwnProperty( pseudo.toLowerCase() ) ?
					markFunction(function( seed, matches ) {
						var idx,
							matched = fn( seed, argument ),
							i = matched.length;
						while ( i-- ) {
							idx = indexOf.call( seed, matched[i] );
							seed[ idx ] = !( matches[ idx ] = matched[i] );
						}
					}) :
					function( elem ) {
						return fn( elem, 0, args );
					};
			}

			return fn;
		}
	},

	pseudos: {
		// Potentially complex pseudos
		"not": markFunction(function( selector ) {
			// Trim the selector passed to compile
			// to avoid treating leading and trailing
			// spaces as combinators
			var input = [],
				results = [],
				matcher = compile( selector.replace( rtrim, "$1" ) );

			return matcher[ expando ] ?
				markFunction(function( seed, matches, context, xml ) {
					var elem,
						unmatched = matcher( seed, null, xml, [] ),
						i = seed.length;

					// Match elements unmatched by `matcher`
					while ( i-- ) {
						if ( (elem = unmatched[i]) ) {
							seed[i] = !(matches[i] = elem);
						}
					}
				}) :
				function( elem, context, xml ) {
					input[0] = elem;
					matcher( input, null, xml, results );
					return !results.pop();
				};
		}),

		"has": markFunction(function( selector ) {
			return function( elem ) {
				return Sizzle( selector, elem ).length > 0;
			};
		}),

		"contains": markFunction(function( text ) {
			return function( elem ) {
				return ( elem.textContent || elem.innerText || getText( elem ) ).indexOf( text ) > -1;
			};
		}),

		// "Whether an element is represented by a :lang() selector
		// is based solely on the element's language value
		// being equal to the identifier C,
		// or beginning with the identifier C immediately followed by "-".
		// The matching of C against the element's language value is performed case-insensitively.
		// The identifier C does not have to be a valid language name."
		// http://www.w3.org/TR/selectors/#lang-pseudo
		"lang": markFunction( function( lang ) {
			// lang value must be a valid identifier
			if ( !ridentifier.test(lang || "") ) {
				Sizzle.error( "unsupported lang: " + lang );
			}
			lang = lang.replace( runescape, funescape ).toLowerCase();
			return function( elem ) {
				var elemLang;
				do {
					if ( (elemLang = documentIsHTML ?
						elem.lang :
						elem.getAttribute("xml:lang") || elem.getAttribute("lang")) ) {

						elemLang = elemLang.toLowerCase();
						return elemLang === lang || elemLang.indexOf( lang + "-" ) === 0;
					}
				} while ( (elem = elem.parentNode) && elem.nodeType === 1 );
				return false;
			};
		}),

		// Miscellaneous
		"target": function( elem ) {
			var hash = window.location && window.location.hash;
			return hash && hash.slice( 1 ) === elem.id;
		},

		"root": function( elem ) {
			return elem === docElem;
		},

		"focus": function( elem ) {
			return elem === document.activeElement && (!document.hasFocus || document.hasFocus()) && !!(elem.type || elem.href || ~elem.tabIndex);
		},

		// Boolean properties
		"enabled": function( elem ) {
			return elem.disabled === false;
		},

		"disabled": function( elem ) {
			return elem.disabled === true;
		},

		"checked": function( elem ) {
			// In CSS3, :checked should return both checked and selected elements
			// http://www.w3.org/TR/2011/REC-css3-selectors-20110929/#checked
			var nodeName = elem.nodeName.toLowerCase();
			return (nodeName === "input" && !!elem.checked) || (nodeName === "option" && !!elem.selected);
		},

		"selected": function( elem ) {
			// Accessing this property makes selected-by-default
			// options in Safari work properly
			if ( elem.parentNode ) {
				elem.parentNode.selectedIndex;
			}

			return elem.selected === true;
		},

		// Contents
		"empty": function( elem ) {
			// http://www.w3.org/TR/selectors/#empty-pseudo
			// :empty is negated by element (1) or content nodes (text: 3; cdata: 4; entity ref: 5),
			//   but not by others (comment: 8; processing instruction: 7; etc.)
			// nodeType < 6 works because attributes (2) do not appear as children
			for ( elem = elem.firstChild; elem; elem = elem.nextSibling ) {
				if ( elem.nodeType < 6 ) {
					return false;
				}
			}
			return true;
		},

		"parent": function( elem ) {
			return !Expr.pseudos["empty"]( elem );
		},

		// Element/input types
		"header": function( elem ) {
			return rheader.test( elem.nodeName );
		},

		"input": function( elem ) {
			return rinputs.test( elem.nodeName );
		},

		"button": function( elem ) {
			var name = elem.nodeName.toLowerCase();
			return name === "input" && elem.type === "button" || name === "button";
		},

		"text": function( elem ) {
			var attr;
			return elem.nodeName.toLowerCase() === "input" &&
				elem.type === "text" &&

				// Support: IE<8
				// New HTML5 attribute values (e.g., "search") appear with elem.type === "text"
				( (attr = elem.getAttribute("type")) == null || attr.toLowerCase() === "text" );
		},

		// Position-in-collection
		"first": createPositionalPseudo(function() {
			return [ 0 ];
		}),

		"last": createPositionalPseudo(function( matchIndexes, length ) {
			return [ length - 1 ];
		}),

		"eq": createPositionalPseudo(function( matchIndexes, length, argument ) {
			return [ argument < 0 ? argument + length : argument ];
		}),

		"even": createPositionalPseudo(function( matchIndexes, length ) {
			var i = 0;
			for ( ; i < length; i += 2 ) {
				matchIndexes.push( i );
			}
			return matchIndexes;
		}),

		"odd": createPositionalPseudo(function( matchIndexes, length ) {
			var i = 1;
			for ( ; i < length; i += 2 ) {
				matchIndexes.push( i );
			}
			return matchIndexes;
		}),

		"lt": createPositionalPseudo(function( matchIndexes, length, argument ) {
			var i = argument < 0 ? argument + length : argument;
			for ( ; --i >= 0; ) {
				matchIndexes.push( i );
			}
			return matchIndexes;
		}),

		"gt": createPositionalPseudo(function( matchIndexes, length, argument ) {
			var i = argument < 0 ? argument + length : argument;
			for ( ; ++i < length; ) {
				matchIndexes.push( i );
			}
			return matchIndexes;
		})
	}
};

Expr.pseudos["nth"] = Expr.pseudos["eq"];

// Add button/input type pseudos
for ( i in { radio: true, checkbox: true, file: true, password: true, image: true } ) {
	Expr.pseudos[ i ] = createInputPseudo( i );
}
for ( i in { submit: true, reset: true } ) {
	Expr.pseudos[ i ] = createButtonPseudo( i );
}

// Easy API for creating new setFilters
function setFilters() {}
setFilters.prototype = Expr.filters = Expr.pseudos;
Expr.setFilters = new setFilters();

function tokenize( selector, parseOnly ) {
	var matched, match, tokens, type,
		soFar, groups, preFilters,
		cached = tokenCache[ selector + " " ];

	if ( cached ) {
		return parseOnly ? 0 : cached.slice( 0 );
	}

	soFar = selector;
	groups = [];
	preFilters = Expr.preFilter;

	while ( soFar ) {

		// Comma and first run
		if ( !matched || (match = rcomma.exec( soFar )) ) {
			if ( match ) {
				// Don't consume trailing commas as valid
				soFar = soFar.slice( match[0].length ) || soFar;
			}
			groups.push( (tokens = []) );
		}

		matched = false;

		// Combinators
		if ( (match = rcombinators.exec( soFar )) ) {
			matched = match.shift();
			tokens.push({
				value: matched,
				// Cast descendant combinators to space
				type: match[0].replace( rtrim, " " )
			});
			soFar = soFar.slice( matched.length );
		}

		// Filters
		for ( type in Expr.filter ) {
			if ( (match = matchExpr[ type ].exec( soFar )) && (!preFilters[ type ] ||
				(match = preFilters[ type ]( match ))) ) {
				matched = match.shift();
				tokens.push({
					value: matched,
					type: type,
					matches: match
				});
				soFar = soFar.slice( matched.length );
			}
		}

		if ( !matched ) {
			break;
		}
	}

	// Return the length of the invalid excess
	// if we're just parsing
	// Otherwise, throw an error or return tokens
	return parseOnly ?
		soFar.length :
		soFar ?
			Sizzle.error( selector ) :
			// Cache the tokens
			tokenCache( selector, groups ).slice( 0 );
}

function toSelector( tokens ) {
	var i = 0,
		len = tokens.length,
		selector = "";
	for ( ; i < len; i++ ) {
		selector += tokens[i].value;
	}
	return selector;
}

function addCombinator( matcher, combinator, base ) {
	var dir = combinator.dir,
		checkNonElements = base && dir === "parentNode",
		doneName = done++;

	return combinator.first ?
		// Check against closest ancestor/preceding element
		function( elem, context, xml ) {
			while ( (elem = elem[ dir ]) ) {
				if ( elem.nodeType === 1 || checkNonElements ) {
					return matcher( elem, context, xml );
				}
			}
		} :

		// Check against all ancestor/preceding elements
		function( elem, context, xml ) {
			var oldCache, outerCache,
				newCache = [ dirruns, doneName ];

			// We can't set arbitrary data on XML nodes, so they don't benefit from dir caching
			if ( xml ) {
				while ( (elem = elem[ dir ]) ) {
					if ( elem.nodeType === 1 || checkNonElements ) {
						if ( matcher( elem, context, xml ) ) {
							return true;
						}
					}
				}
			} else {
				while ( (elem = elem[ dir ]) ) {
					if ( elem.nodeType === 1 || checkNonElements ) {
						outerCache = elem[ expando ] || (elem[ expando ] = {});
						if ( (oldCache = outerCache[ dir ]) &&
							oldCache[ 0 ] === dirruns && oldCache[ 1 ] === doneName ) {

							// Assign to newCache so results back-propagate to previous elements
							return (newCache[ 2 ] = oldCache[ 2 ]);
						} else {
							// Reuse newcache so results back-propagate to previous elements
							outerCache[ dir ] = newCache;

							// A match means we're done; a fail means we have to keep checking
							if ( (newCache[ 2 ] = matcher( elem, context, xml )) ) {
								return true;
							}
						}
					}
				}
			}
		};
}

function elementMatcher( matchers ) {
	return matchers.length > 1 ?
		function( elem, context, xml ) {
			var i = matchers.length;
			while ( i-- ) {
				if ( !matchers[i]( elem, context, xml ) ) {
					return false;
				}
			}
			return true;
		} :
		matchers[0];
}

function condense( unmatched, map, filter, context, xml ) {
	var elem,
		newUnmatched = [],
		i = 0,
		len = unmatched.length,
		mapped = map != null;

	for ( ; i < len; i++ ) {
		if ( (elem = unmatched[i]) ) {
			if ( !filter || filter( elem, context, xml ) ) {
				newUnmatched.push( elem );
				if ( mapped ) {
					map.push( i );
				}
			}
		}
	}

	return newUnmatched;
}

function setMatcher( preFilter, selector, matcher, postFilter, postFinder, postSelector ) {
	if ( postFilter && !postFilter[ expando ] ) {
		postFilter = setMatcher( postFilter );
	}
	if ( postFinder && !postFinder[ expando ] ) {
		postFinder = setMatcher( postFinder, postSelector );
	}
	return markFunction(function( seed, results, context, xml ) {
		var temp, i, elem,
			preMap = [],
			postMap = [],
			preexisting = results.length,

			// Get initial elements from seed or context
			elems = seed || multipleContexts( selector || "*", context.nodeType ? [ context ] : context, [] ),

			// Prefilter to get matcher input, preserving a map for seed-results synchronization
			matcherIn = preFilter && ( seed || !selector ) ?
				condense( elems, preMap, preFilter, context, xml ) :
				elems,

			matcherOut = matcher ?
				// If we have a postFinder, or filtered seed, or non-seed postFilter or preexisting results,
				postFinder || ( seed ? preFilter : preexisting || postFilter ) ?

					// ...intermediate processing is necessary
					[] :

					// ...otherwise use results directly
					results :
				matcherIn;

		// Find primary matches
		if ( matcher ) {
			matcher( matcherIn, matcherOut, context, xml );
		}

		// Apply postFilter
		if ( postFilter ) {
			temp = condense( matcherOut, postMap );
			postFilter( temp, [], context, xml );

			// Un-match failing elements by moving them back to matcherIn
			i = temp.length;
			while ( i-- ) {
				if ( (elem = temp[i]) ) {
					matcherOut[ postMap[i] ] = !(matcherIn[ postMap[i] ] = elem);
				}
			}
		}

		if ( seed ) {
			if ( postFinder || preFilter ) {
				if ( postFinder ) {
					// Get the final matcherOut by condensing this intermediate into postFinder contexts
					temp = [];
					i = matcherOut.length;
					while ( i-- ) {
						if ( (elem = matcherOut[i]) ) {
							// Restore matcherIn since elem is not yet a final match
							temp.push( (matcherIn[i] = elem) );
						}
					}
					postFinder( null, (matcherOut = []), temp, xml );
				}

				// Move matched elements from seed to results to keep them synchronized
				i = matcherOut.length;
				while ( i-- ) {
					if ( (elem = matcherOut[i]) &&
						(temp = postFinder ? indexOf.call( seed, elem ) : preMap[i]) > -1 ) {

						seed[temp] = !(results[temp] = elem);
					}
				}
			}

		// Add elements to results, through postFinder if defined
		} else {
			matcherOut = condense(
				matcherOut === results ?
					matcherOut.splice( preexisting, matcherOut.length ) :
					matcherOut
			);
			if ( postFinder ) {
				postFinder( null, results, matcherOut, xml );
			} else {
				push.apply( results, matcherOut );
			}
		}
	});
}

function matcherFromTokens( tokens ) {
	var checkContext, matcher, j,
		len = tokens.length,
		leadingRelative = Expr.relative[ tokens[0].type ],
		implicitRelative = leadingRelative || Expr.relative[" "],
		i = leadingRelative ? 1 : 0,

		// The foundational matcher ensures that elements are reachable from top-level context(s)
		matchContext = addCombinator( function( elem ) {
			return elem === checkContext;
		}, implicitRelative, true ),
		matchAnyContext = addCombinator( function( elem ) {
			return indexOf.call( checkContext, elem ) > -1;
		}, implicitRelative, true ),
		matchers = [ function( elem, context, xml ) {
			return ( !leadingRelative && ( xml || context !== outermostContext ) ) || (
				(checkContext = context).nodeType ?
					matchContext( elem, context, xml ) :
					matchAnyContext( elem, context, xml ) );
		} ];

	for ( ; i < len; i++ ) {
		if ( (matcher = Expr.relative[ tokens[i].type ]) ) {
			matchers = [ addCombinator(elementMatcher( matchers ), matcher) ];
		} else {
			matcher = Expr.filter[ tokens[i].type ].apply( null, tokens[i].matches );

			// Return special upon seeing a positional matcher
			if ( matcher[ expando ] ) {
				// Find the next relative operator (if any) for proper handling
				j = ++i;
				for ( ; j < len; j++ ) {
					if ( Expr.relative[ tokens[j].type ] ) {
						break;
					}
				}
				return setMatcher(
					i > 1 && elementMatcher( matchers ),
					i > 1 && toSelector(
						// If the preceding token was a descendant combinator, insert an implicit any-element `*`
						tokens.slice( 0, i - 1 ).concat({ value: tokens[ i - 2 ].type === " " ? "*" : "" })
					).replace( rtrim, "$1" ),
					matcher,
					i < j && matcherFromTokens( tokens.slice( i, j ) ),
					j < len && matcherFromTokens( (tokens = tokens.slice( j )) ),
					j < len && toSelector( tokens )
				);
			}
			matchers.push( matcher );
		}
	}

	return elementMatcher( matchers );
}

function matcherFromGroupMatchers( elementMatchers, setMatchers ) {
	var bySet = setMatchers.length > 0,
		byElement = elementMatchers.length > 0,
		superMatcher = function( seed, context, xml, results, outermost ) {
			var elem, j, matcher,
				matchedCount = 0,
				i = "0",
				unmatched = seed && [],
				setMatched = [],
				contextBackup = outermostContext,
				// We must always have either seed elements or outermost context
				elems = seed || byElement && Expr.find["TAG"]( "*", outermost ),
				// Use integer dirruns iff this is the outermost matcher
				dirrunsUnique = (dirruns += contextBackup == null ? 1 : Math.random() || 0.1),
				len = elems.length;

			if ( outermost ) {
				outermostContext = context !== document && context;
			}

			// Add elements passing elementMatchers directly to results
			// Keep `i` a string if there are no elements so `matchedCount` will be "00" below
			// Support: IE<9, Safari
			// Tolerate NodeList properties (IE: "length"; Safari: <number>) matching elements by id
			for ( ; i !== len && (elem = elems[i]) != null; i++ ) {
				if ( byElement && elem ) {
					j = 0;
					while ( (matcher = elementMatchers[j++]) ) {
						if ( matcher( elem, context, xml ) ) {
							results.push( elem );
							break;
						}
					}
					if ( outermost ) {
						dirruns = dirrunsUnique;
					}
				}

				// Track unmatched elements for set filters
				if ( bySet ) {
					// They will have gone through all possible matchers
					if ( (elem = !matcher && elem) ) {
						matchedCount--;
					}

					// Lengthen the array for every element, matched or not
					if ( seed ) {
						unmatched.push( elem );
					}
				}
			}

			// Apply set filters to unmatched elements
			matchedCount += i;
			if ( bySet && i !== matchedCount ) {
				j = 0;
				while ( (matcher = setMatchers[j++]) ) {
					matcher( unmatched, setMatched, context, xml );
				}

				if ( seed ) {
					// Reintegrate element matches to eliminate the need for sorting
					if ( matchedCount > 0 ) {
						while ( i-- ) {
							if ( !(unmatched[i] || setMatched[i]) ) {
								setMatched[i] = pop.call( results );
							}
						}
					}

					// Discard index placeholder values to get only actual matches
					setMatched = condense( setMatched );
				}

				// Add matches to results
				push.apply( results, setMatched );

				// Seedless set matches succeeding multiple successful matchers stipulate sorting
				if ( outermost && !seed && setMatched.length > 0 &&
					( matchedCount + setMatchers.length ) > 1 ) {

					Sizzle.uniqueSort( results );
				}
			}

			// Override manipulation of globals by nested matchers
			if ( outermost ) {
				dirruns = dirrunsUnique;
				outermostContext = contextBackup;
			}

			return unmatched;
		};

	return bySet ?
		markFunction( superMatcher ) :
		superMatcher;
}

compile = Sizzle.compile = function( selector, group /* Internal Use Only */ ) {
	var i,
		setMatchers = [],
		elementMatchers = [],
		cached = compilerCache[ selector + " " ];

	if ( !cached ) {
		// Generate a function of recursive functions that can be used to check each element
		if ( !group ) {
			group = tokenize( selector );
		}
		i = group.length;
		while ( i-- ) {
			cached = matcherFromTokens( group[i] );
			if ( cached[ expando ] ) {
				setMatchers.push( cached );
			} else {
				elementMatchers.push( cached );
			}
		}

		// Cache the compiled function
		cached = compilerCache( selector, matcherFromGroupMatchers( elementMatchers, setMatchers ) );
	}
	return cached;
};

function multipleContexts( selector, contexts, results ) {
	var i = 0,
		len = contexts.length;
	for ( ; i < len; i++ ) {
		Sizzle( selector, contexts[i], results );
	}
	return results;
}

function select( selector, context, results, seed ) {
	var i, tokens, token, type, find,
		match = tokenize( selector );

	if ( !seed ) {
		// Try to minimize operations if there is only one group
		if ( match.length === 1 ) {

			// Take a shortcut and set the context if the root selector is an ID
			tokens = match[0] = match[0].slice( 0 );
			if ( tokens.length > 2 && (token = tokens[0]).type === "ID" &&
					support.getById && context.nodeType === 9 && documentIsHTML &&
					Expr.relative[ tokens[1].type ] ) {

				context = ( Expr.find["ID"]( token.matches[0].replace(runescape, funescape), context ) || [] )[0];
				if ( !context ) {
					return results;
				}
				selector = selector.slice( tokens.shift().value.length );
			}

			// Fetch a seed set for right-to-left matching
			i = matchExpr["needsContext"].test( selector ) ? 0 : tokens.length;
			while ( i-- ) {
				token = tokens[i];

				// Abort if we hit a combinator
				if ( Expr.relative[ (type = token.type) ] ) {
					break;
				}
				if ( (find = Expr.find[ type ]) ) {
					// Search, expanding context for leading sibling combinators
					if ( (seed = find(
						token.matches[0].replace( runescape, funescape ),
						rsibling.test( tokens[0].type ) && testContext( context.parentNode ) || context
					)) ) {

						// If seed is empty or no tokens remain, we can return early
						tokens.splice( i, 1 );
						selector = seed.length && toSelector( tokens );
						if ( !selector ) {
							push.apply( results, seed );
							return results;
						}

						break;
					}
				}
			}
		}
	}

	// Compile and execute a filtering function
	// Provide `match` to avoid retokenization if we modified the selector above
	compile( selector, match )(
		seed,
		context,
		!documentIsHTML,
		results,
		rsibling.test( selector ) && testContext( context.parentNode ) || context
	);
	return results;
}

// One-time assignments

// Sort stability
support.sortStable = expando.split("").sort( sortOrder ).join("") === expando;

// Support: Chrome<14
// Always assume duplicates if they aren't passed to the comparison function
support.detectDuplicates = !!hasDuplicate;

// Initialize against the default document
setDocument();

// Support: Webkit<537.32 - Safari 6.0.3/Chrome 25 (fixed in Chrome 27)
// Detached nodes confoundingly follow *each other*
support.sortDetached = assert(function( div1 ) {
	// Should return 1, but returns 4 (following)
	return div1.compareDocumentPosition( document.createElement("div") ) & 1;
});

// Support: IE<8
// Prevent attribute/property "interpolation"
// http://msdn.microsoft.com/en-us/library/ms536429%28VS.85%29.aspx
if ( !assert(function( div ) {
	div.innerHTML = "<a href='#'></a>";
	return div.firstChild.getAttribute("href") === "#" ;
}) ) {
	addHandle( "type|href|height|width", function( elem, name, isXML ) {
		if ( !isXML ) {
			return elem.getAttribute( name, name.toLowerCase() === "type" ? 1 : 2 );
		}
	});
}

// Support: IE<9
// Use defaultValue in place of getAttribute("value")
if ( !support.attributes || !assert(function( div ) {
	div.innerHTML = "<input/>";
	div.firstChild.setAttribute( "value", "" );
	return div.firstChild.getAttribute( "value" ) === "";
}) ) {
	addHandle( "value", function( elem, name, isXML ) {
		if ( !isXML && elem.nodeName.toLowerCase() === "input" ) {
			return elem.defaultValue;
		}
	});
}

// Support: IE<9
// Use getAttributeNode to fetch booleans when getAttribute lies
if ( !assert(function( div ) {
	return div.getAttribute("disabled") == null;
}) ) {
	addHandle( booleans, function( elem, name, isXML ) {
		var val;
		if ( !isXML ) {
			return elem[ name ] === true ? name.toLowerCase() :
					(val = elem.getAttributeNode( name )) && val.specified ?
					val.value :
				null;
		}
	});
}

return Sizzle;

})( window );



jQuery.find = Sizzle;
jQuery.expr = Sizzle.selectors;
jQuery.expr[":"] = jQuery.expr.pseudos;
jQuery.unique = Sizzle.uniqueSort;
jQuery.text = Sizzle.getText;
jQuery.isXMLDoc = Sizzle.isXML;
jQuery.contains = Sizzle.contains;



var rneedsContext = jQuery.expr.match.needsContext;

var rsingleTag = (/^<(\w+)\s*\/?>(?:<\/\1>|)$/);



var risSimple = /^.[^:#\[\.,]*$/;

// Implement the identical functionality for filter and not
function winnow( elements, qualifier, not ) {
	if ( jQuery.isFunction( qualifier ) ) {
		return jQuery.grep( elements, function( elem, i ) {
			/* jshint -W018 */
			return !!qualifier.call( elem, i, elem ) !== not;
		});

	}

	if ( qualifier.nodeType ) {
		return jQuery.grep( elements, function( elem ) {
			return ( elem === qualifier ) !== not;
		});

	}

	if ( typeof qualifier === "string" ) {
		if ( risSimple.test( qualifier ) ) {
			return jQuery.filter( qualifier, elements, not );
		}

		qualifier = jQuery.filter( qualifier, elements );
	}

	return jQuery.grep( elements, function( elem ) {
		return ( jQuery.inArray( elem, qualifier ) >= 0 ) !== not;
	});
}

jQuery.filter = function( expr, elems, not ) {
	var elem = elems[ 0 ];

	if ( not ) {
		expr = ":not(" + expr + ")";
	}

	return elems.length === 1 && elem.nodeType === 1 ?
		jQuery.find.matchesSelector( elem, expr ) ? [ elem ] : [] :
		jQuery.find.matches( expr, jQuery.grep( elems, function( elem ) {
			return elem.nodeType === 1;
		}));
};

jQuery.fn.extend({
	find: function( selector ) {
		var i,
			ret = [],
			self = this,
			len = self.length;

		if ( typeof selector !== "string" ) {
			return this.pushStack( jQuery( selector ).filter(function() {
				for ( i = 0; i < len; i++ ) {
					if ( jQuery.contains( self[ i ], this ) ) {
						return true;
					}
				}
			}) );
		}

		for ( i = 0; i < len; i++ ) {
			jQuery.find( selector, self[ i ], ret );
		}

		// Needed because $( selector, context ) becomes $( context ).find( selector )
		ret = this.pushStack( len > 1 ? jQuery.unique( ret ) : ret );
		ret.selector = this.selector ? this.selector + " " + selector : selector;
		return ret;
	},
	filter: function( selector ) {
		return this.pushStack( winnow(this, selector || [], false) );
	},
	not: function( selector ) {
		return this.pushStack( winnow(this, selector || [], true) );
	},
	is: function( selector ) {
		return !!winnow(
			this,

			// If this is a positional/relative selector, check membership in the returned set
			// so $("p:first").is("p:last") won't return true for a doc with two "p".
			typeof selector === "string" && rneedsContext.test( selector ) ?
				jQuery( selector ) :
				selector || [],
			false
		).length;
	}
});


// Initialize a jQuery object


// A central reference to the root jQuery(document)
var rootjQuery,

	// Use the correct document accordingly with window argument (sandbox)
	document = window.document,

	// A simple way to check for HTML strings
	// Prioritize #id over <tag> to avoid XSS via location.hash (#9521)
	// Strict HTML recognition (#11290: must start with <)
	rquickExpr = /^(?:\s*(<[\w\W]+>)[^>]*|#([\w-]*))$/,

	init = jQuery.fn.init = function( selector, context ) {
		var match, elem;

		// HANDLE: $(""), $(null), $(undefined), $(false)
		if ( !selector ) {
			return this;
		}

		// Handle HTML strings
		if ( typeof selector === "string" ) {
			if ( selector.charAt(0) === "<" && selector.charAt( selector.length - 1 ) === ">" && selector.length >= 3 ) {
				// Assume that strings that start and end with <> are HTML and skip the regex check
				match = [ null, selector, null ];

			} else {
				match = rquickExpr.exec( selector );
			}

			// Match html or make sure no context is specified for #id
			if ( match && (match[1] || !context) ) {

				// HANDLE: $(html) -> $(array)
				if ( match[1] ) {
					context = context instanceof jQuery ? context[0] : context;

					// scripts is true for back-compat
					// Intentionally let the error be thrown if parseHTML is not present
					jQuery.merge( this, jQuery.parseHTML(
						match[1],
						context && context.nodeType ? context.ownerDocument || context : document,
						true
					) );

					// HANDLE: $(html, props)
					if ( rsingleTag.test( match[1] ) && jQuery.isPlainObject( context ) ) {
						for ( match in context ) {
							// Properties of context are called as methods if possible
							if ( jQuery.isFunction( this[ match ] ) ) {
								this[ match ]( context[ match ] );

							// ...and otherwise set as attributes
							} else {
								this.attr( match, context[ match ] );
							}
						}
					}

					return this;

				// HANDLE: $(#id)
				} else {
					elem = document.getElementById( match[2] );

					// Check parentNode to catch when Blackberry 4.6 returns
					// nodes that are no longer in the document #6963
					if ( elem && elem.parentNode ) {
						// Handle the case where IE and Opera return items
						// by name instead of ID
						if ( elem.id !== match[2] ) {
							return rootjQuery.find( selector );
						}

						// Otherwise, we inject the element directly into the jQuery object
						this.length = 1;
						this[0] = elem;
					}

					this.context = document;
					this.selector = selector;
					return this;
				}

			// HANDLE: $(expr, $(...))
			} else if ( !context || context.jquery ) {
				return ( context || rootjQuery ).find( selector );

			// HANDLE: $(expr, context)
			// (which is just equivalent to: $(context).find(expr)
			} else {
				return this.constructor( context ).find( selector );
			}

		// HANDLE: $(DOMElement)
		} else if ( selector.nodeType ) {
			this.context = this[0] = selector;
			this.length = 1;
			return this;

		// HANDLE: $(function)
		// Shortcut for document ready
		} else if ( jQuery.isFunction( selector ) ) {
			return typeof rootjQuery.ready !== "undefined" ?
				rootjQuery.ready( selector ) :
				// Execute immediately if ready is not present
				selector( jQuery );
		}

		if ( selector.selector !== undefined ) {
			this.selector = selector.selector;
			this.context = selector.context;
		}

		return jQuery.makeArray( selector, this );
	};

// Give the init function the jQuery prototype for later instantiation
init.prototype = jQuery.fn;

// Initialize central reference
rootjQuery = jQuery( document );


var rparentsprev = /^(?:parents|prev(?:Until|All))/,
	// methods guaranteed to produce a unique set when starting from a unique set
	guaranteedUnique = {
		children: true,
		contents: true,
		next: true,
		prev: true
	};

jQuery.extend({
	dir: function( elem, dir, until ) {
		var matched = [],
			cur = elem[ dir ];

		while ( cur && cur.nodeType !== 9 && (until === undefined || cur.nodeType !== 1 || !jQuery( cur ).is( until )) ) {
			if ( cur.nodeType === 1 ) {
				matched.push( cur );
			}
			cur = cur[dir];
		}
		return matched;
	},

	sibling: function( n, elem ) {
		var r = [];

		for ( ; n; n = n.nextSibling ) {
			if ( n.nodeType === 1 && n !== elem ) {
				r.push( n );
			}
		}

		return r;
	}
});

jQuery.fn.extend({
	has: function( target ) {
		var i,
			targets = jQuery( target, this ),
			len = targets.length;

		return this.filter(function() {
			for ( i = 0; i < len; i++ ) {
				if ( jQuery.contains( this, targets[i] ) ) {
					return true;
				}
			}
		});
	},

	closest: function( selectors, context ) {
		var cur,
			i = 0,
			l = this.length,
			matched = [],
			pos = rneedsContext.test( selectors ) || typeof selectors !== "string" ?
				jQuery( selectors, context || this.context ) :
				0;

		for ( ; i < l; i++ ) {
			for ( cur = this[i]; cur && cur !== context; cur = cur.parentNode ) {
				// Always skip document fragments
				if ( cur.nodeType < 11 && (pos ?
					pos.index(cur) > -1 :

					// Don't pass non-elements to Sizzle
					cur.nodeType === 1 &&
						jQuery.find.matchesSelector(cur, selectors)) ) {

					matched.push( cur );
					break;
				}
			}
		}

		return this.pushStack( matched.length > 1 ? jQuery.unique( matched ) : matched );
	},

	// Determine the position of an element within
	// the matched set of elements
	index: function( elem ) {

		// No argument, return index in parent
		if ( !elem ) {
			return ( this[0] && this[0].parentNode ) ? this.first().prevAll().length : -1;
		}

		// index in selector
		if ( typeof elem === "string" ) {
			return jQuery.inArray( this[0], jQuery( elem ) );
		}

		// Locate the position of the desired element
		return jQuery.inArray(
			// If it receives a jQuery object, the first element is used
			elem.jquery ? elem[0] : elem, this );
	},

	add: function( selector, context ) {
		return this.pushStack(
			jQuery.unique(
				jQuery.merge( this.get(), jQuery( selector, context ) )
			)
		);
	},

	addBack: function( selector ) {
		return this.add( selector == null ?
			this.prevObject : this.prevObject.filter(selector)
		);
	}
});

function sibling( cur, dir ) {
	do {
		cur = cur[ dir ];
	} while ( cur && cur.nodeType !== 1 );

	return cur;
}

jQuery.each({
	parent: function( elem ) {
		var parent = elem.parentNode;
		return parent && parent.nodeType !== 11 ? parent : null;
	},
	parents: function( elem ) {
		return jQuery.dir( elem, "parentNode" );
	},
	parentsUntil: function( elem, i, until ) {
		return jQuery.dir( elem, "parentNode", until );
	},
	next: function( elem ) {
		return sibling( elem, "nextSibling" );
	},
	prev: function( elem ) {
		return sibling( elem, "previousSibling" );
	},
	nextAll: function( elem ) {
		return jQuery.dir( elem, "nextSibling" );
	},
	prevAll: function( elem ) {
		return jQuery.dir( elem, "previousSibling" );
	},
	nextUntil: function( elem, i, until ) {
		return jQuery.dir( elem, "nextSibling", until );
	},
	prevUntil: function( elem, i, until ) {
		return jQuery.dir( elem, "previousSibling", until );
	},
	siblings: function( elem ) {
		return jQuery.sibling( ( elem.parentNode || {} ).firstChild, elem );
	},
	children: function( elem ) {
		return jQuery.sibling( elem.firstChild );
	},
	contents: function( elem ) {
		return jQuery.nodeName( elem, "iframe" ) ?
			elem.contentDocument || elem.contentWindow.document :
			jQuery.merge( [], elem.childNodes );
	}
}, function( name, fn ) {
	jQuery.fn[ name ] = function( until, selector ) {
		var ret = jQuery.map( this, fn, until );

		if ( name.slice( -5 ) !== "Until" ) {
			selector = until;
		}

		if ( selector && typeof selector === "string" ) {
			ret = jQuery.filter( selector, ret );
		}

		if ( this.length > 1 ) {
			// Remove duplicates
			if ( !guaranteedUnique[ name ] ) {
				ret = jQuery.unique( ret );
			}

			// Reverse order for parents* and prev-derivatives
			if ( rparentsprev.test( name ) ) {
				ret = ret.reverse();
			}
		}

		return this.pushStack( ret );
	};
});
var rnotwhite = (/\S+/g);



// String to Object options format cache
var optionsCache = {};

// Convert String-formatted options into Object-formatted ones and store in cache
function createOptions( options ) {
	var object = optionsCache[ options ] = {};
	jQuery.each( options.match( rnotwhite ) || [], function( _, flag ) {
		object[ flag ] = true;
	});
	return object;
}

/*
 * Create a callback list using the following parameters:
 *
 *	options: an optional list of space-separated options that will change how
 *			the callback list behaves or a more traditional option object
 *
 * By default a callback list will act like an event callback list and can be
 * "fired" multiple times.
 *
 * Possible options:
 *
 *	once:			will ensure the callback list can only be fired once (like a Deferred)
 *
 *	memory:			will keep track of previous values and will call any callback added
 *					after the list has been fired right away with the latest "memorized"
 *					values (like a Deferred)
 *
 *	unique:			will ensure a callback can only be added once (no duplicate in the list)
 *
 *	stopOnFalse:	interrupt callings when a callback returns false
 *
 */
jQuery.Callbacks = function( options ) {

	// Convert options from String-formatted to Object-formatted if needed
	// (we check in cache first)
	options = typeof options === "string" ?
		( optionsCache[ options ] || createOptions( options ) ) :
		jQuery.extend( {}, options );

	var // Flag to know if list is currently firing
		firing,
		// Last fire value (for non-forgettable lists)
		memory,
		// Flag to know if list was already fired
		fired,
		// End of the loop when firing
		firingLength,
		// Index of currently firing callback (modified by remove if needed)
		firingIndex,
		// First callback to fire (used internally by add and fireWith)
		firingStart,
		// Actual callback list
		list = [],
		// Stack of fire calls for repeatable lists
		stack = !options.once && [],
		// Fire callbacks
		fire = function( data ) {
			memory = options.memory && data;
			fired = true;
			firingIndex = firingStart || 0;
			firingStart = 0;
			firingLength = list.length;
			firing = true;
			for ( ; list && firingIndex < firingLength; firingIndex++ ) {
				if ( list[ firingIndex ].apply( data[ 0 ], data[ 1 ] ) === false && options.stopOnFalse ) {
					memory = false; // To prevent further calls using add
					break;
				}
			}
			firing = false;
			if ( list ) {
				if ( stack ) {
					if ( stack.length ) {
						fire( stack.shift() );
					}
				} else if ( memory ) {
					list = [];
				} else {
					self.disable();
				}
			}
		},
		// Actual Callbacks object
		self = {
			// Add a callback or a collection of callbacks to the list
			add: function() {
				if ( list ) {
					// First, we save the current length
					var start = list.length;
					(function add( args ) {
						jQuery.each( args, function( _, arg ) {
							var type = jQuery.type( arg );
							if ( type === "function" ) {
								if ( !options.unique || !self.has( arg ) ) {
									list.push( arg );
								}
							} else if ( arg && arg.length && type !== "string" ) {
								// Inspect recursively
								add( arg );
							}
						});
					})( arguments );
					// Do we need to add the callbacks to the
					// current firing batch?
					if ( firing ) {
						firingLength = list.length;
					// With memory, if we're not firing then
					// we should call right away
					} else if ( memory ) {
						firingStart = start;
						fire( memory );
					}
				}
				return this;
			},
			// Remove a callback from the list
			remove: function() {
				if ( list ) {
					jQuery.each( arguments, function( _, arg ) {
						var index;
						while ( ( index = jQuery.inArray( arg, list, index ) ) > -1 ) {
							list.splice( index, 1 );
							// Handle firing indexes
							if ( firing ) {
								if ( index <= firingLength ) {
									firingLength--;
								}
								if ( index <= firingIndex ) {
									firingIndex--;
								}
							}
						}
					});
				}
				return this;
			},
			// Check if a given callback is in the list.
			// If no argument is given, return whether or not list has callbacks attached.
			has: function( fn ) {
				return fn ? jQuery.inArray( fn, list ) > -1 : !!( list && list.length );
			},
			// Remove all callbacks from the list
			empty: function() {
				list = [];
				firingLength = 0;
				return this;
			},
			// Have the list do nothing anymore
			disable: function() {
				list = stack = memory = undefined;
				return this;
			},
			// Is it disabled?
			disabled: function() {
				return !list;
			},
			// Lock the list in its current state
			lock: function() {
				stack = undefined;
				if ( !memory ) {
					self.disable();
				}
				return this;
			},
			// Is it locked?
			locked: function() {
				return !stack;
			},
			// Call all callbacks with the given context and arguments
			fireWith: function( context, args ) {
				if ( list && ( !fired || stack ) ) {
					args = args || [];
					args = [ context, args.slice ? args.slice() : args ];
					if ( firing ) {
						stack.push( args );
					} else {
						fire( args );
					}
				}
				return this;
			},
			// Call all the callbacks with the given arguments
			fire: function() {
				self.fireWith( this, arguments );
				return this;
			},
			// To know if the callbacks have already been called at least once
			fired: function() {
				return !!fired;
			}
		};

	return self;
};


jQuery.extend({

	Deferred: function( func ) {
		var tuples = [
				// action, add listener, listener list, final state
				[ "resolve", "done", jQuery.Callbacks("once memory"), "resolved" ],
				[ "reject", "fail", jQuery.Callbacks("once memory"), "rejected" ],
				[ "notify", "progress", jQuery.Callbacks("memory") ]
			],
			state = "pending",
			promise = {
				state: function() {
					return state;
				},
				always: function() {
					deferred.done( arguments ).fail( arguments );
					return this;
				},
				then: function( /* fnDone, fnFail, fnProgress */ ) {
					var fns = arguments;
					return jQuery.Deferred(function( newDefer ) {
						jQuery.each( tuples, function( i, tuple ) {
							var fn = jQuery.isFunction( fns[ i ] ) && fns[ i ];
							// deferred[ done | fail | progress ] for forwarding actions to newDefer
							deferred[ tuple[1] ](function() {
								var returned = fn && fn.apply( this, arguments );
								if ( returned && jQuery.isFunction( returned.promise ) ) {
									returned.promise()
										.done( newDefer.resolve )
										.fail( newDefer.reject )
										.progress( newDefer.notify );
								} else {
									newDefer[ tuple[ 0 ] + "With" ]( this === promise ? newDefer.promise() : this, fn ? [ returned ] : arguments );
								}
							});
						});
						fns = null;
					}).promise();
				},
				// Get a promise for this deferred
				// If obj is provided, the promise aspect is added to the object
				promise: function( obj ) {
					return obj != null ? jQuery.extend( obj, promise ) : promise;
				}
			},
			deferred = {};

		// Keep pipe for back-compat
		promise.pipe = promise.then;

		// Add list-specific methods
		jQuery.each( tuples, function( i, tuple ) {
			var list = tuple[ 2 ],
				stateString = tuple[ 3 ];

			// promise[ done | fail | progress ] = list.add
			promise[ tuple[1] ] = list.add;

			// Handle state
			if ( stateString ) {
				list.add(function() {
					// state = [ resolved | rejected ]
					state = stateString;

				// [ reject_list | resolve_list ].disable; progress_list.lock
				}, tuples[ i ^ 1 ][ 2 ].disable, tuples[ 2 ][ 2 ].lock );
			}

			// deferred[ resolve | reject | notify ]
			deferred[ tuple[0] ] = function() {
				deferred[ tuple[0] + "With" ]( this === deferred ? promise : this, arguments );
				return this;
			};
			deferred[ tuple[0] + "With" ] = list.fireWith;
		});

		// Make the deferred a promise
		promise.promise( deferred );

		// Call given func if any
		if ( func ) {
			func.call( deferred, deferred );
		}

		// All done!
		return deferred;
	},

	// Deferred helper
	when: function( subordinate /* , ..., subordinateN */ ) {
		var i = 0,
			resolveValues = slice.call( arguments ),
			length = resolveValues.length,

			// the count of uncompleted subordinates
			remaining = length !== 1 || ( subordinate && jQuery.isFunction( subordinate.promise ) ) ? length : 0,

			// the master Deferred. If resolveValues consist of only a single Deferred, just use that.
			deferred = remaining === 1 ? subordinate : jQuery.Deferred(),

			// Update function for both resolve and progress values
			updateFunc = function( i, contexts, values ) {
				return function( value ) {
					contexts[ i ] = this;
					values[ i ] = arguments.length > 1 ? slice.call( arguments ) : value;
					if ( values === progressValues ) {
						deferred.notifyWith( contexts, values );

					} else if ( !(--remaining) ) {
						deferred.resolveWith( contexts, values );
					}
				};
			},

			progressValues, progressContexts, resolveContexts;

		// add listeners to Deferred subordinates; treat others as resolved
		if ( length > 1 ) {
			progressValues = new Array( length );
			progressContexts = new Array( length );
			resolveContexts = new Array( length );
			for ( ; i < length; i++ ) {
				if ( resolveValues[ i ] && jQuery.isFunction( resolveValues[ i ].promise ) ) {
					resolveValues[ i ].promise()
						.done( updateFunc( i, resolveContexts, resolveValues ) )
						.fail( deferred.reject )
						.progress( updateFunc( i, progressContexts, progressValues ) );
				} else {
					--remaining;
				}
			}
		}

		// if we're not waiting on anything, resolve the master
		if ( !remaining ) {
			deferred.resolveWith( resolveContexts, resolveValues );
		}

		return deferred.promise();
	}
});


// The deferred used on DOM ready
var readyList;

jQuery.fn.ready = function( fn ) {
	// Add the callback
	jQuery.ready.promise().done( fn );

	return this;
};

jQuery.extend({
	// Is the DOM ready to be used? Set to true once it occurs.
	isReady: false,

	// A counter to track how many items to wait for before
	// the ready event fires. See #6781
	readyWait: 1,

	// Hold (or release) the ready event
	holdReady: function( hold ) {
		if ( hold ) {
			jQuery.readyWait++;
		} else {
			jQuery.ready( true );
		}
	},

	// Handle when the DOM is ready
	ready: function( wait ) {

		// Abort if there are pending holds or we're already ready
		if ( wait === true ? --jQuery.readyWait : jQuery.isReady ) {
			return;
		}

		// Make sure body exists, at least, in case IE gets a little overzealous (ticket #5443).
		if ( !document.body ) {
			return setTimeout( jQuery.ready );
		}

		// Remember that the DOM is ready
		jQuery.isReady = true;

		// If a normal DOM Ready event fired, decrement, and wait if need be
		if ( wait !== true && --jQuery.readyWait > 0 ) {
			return;
		}

		// If there are functions bound, to execute
		readyList.resolveWith( document, [ jQuery ] );

		// Trigger any bound ready events
		if ( jQuery.fn.trigger ) {
			jQuery( document ).trigger("ready").off("ready");
		}
	}
});

/**
 * Clean-up method for dom ready events
 */
function detach() {
	if ( document.addEventListener ) {
		document.removeEventListener( "DOMContentLoaded", completed, false );
		window.removeEventListener( "load", completed, false );

	} else {
		document.detachEvent( "onreadystatechange", completed );
		window.detachEvent( "onload", completed );
	}
}

/**
 * The ready event handler and self cleanup method
 */
function completed() {
	// readyState === "complete" is good enough for us to call the dom ready in oldIE
	if ( document.addEventListener || event.type === "load" || document.readyState === "complete" ) {
		detach();
		jQuery.ready();
	}
}

jQuery.ready.promise = function( obj ) {
	if ( !readyList ) {

		readyList = jQuery.Deferred();

		// Catch cases where $(document).ready() is called after the browser event has already occurred.
		// we once tried to use readyState "interactive" here, but it caused issues like the one
		// discovered by ChrisS here: http://bugs.jquery.com/ticket/12282#comment:15
		if ( document.readyState === "complete" ) {
			// Handle it asynchronously to allow scripts the opportunity to delay ready
			setTimeout( jQuery.ready );

		// Standards-based browsers support DOMContentLoaded
		} else if ( document.addEventListener ) {
			// Use the handy event callback
			document.addEventListener( "DOMContentLoaded", completed, false );

			// A fallback to window.onload, that will always work
			window.addEventListener( "load", completed, false );

		// If IE event model is used
		} else {
			// Ensure firing before onload, maybe late but safe also for iframes
			document.attachEvent( "onreadystatechange", completed );

			// A fallback to window.onload, that will always work
			window.attachEvent( "onload", completed );

			// If IE and not a frame
			// continually check to see if the document is ready
			var top = false;

			try {
				top = window.frameElement == null && document.documentElement;
			} catch(e) {}

			if ( top && top.doScroll ) {
				(function doScrollCheck() {
					if ( !jQuery.isReady ) {

						try {
							// Use the trick by Diego Perini
							// http://javascript.nwbox.com/IEContentLoaded/
							top.doScroll("left");
						} catch(e) {
							return setTimeout( doScrollCheck, 50 );
						}

						// detach all dom ready events
						detach();

						// and execute any waiting functions
						jQuery.ready();
					}
				})();
			}
		}
	}
	return readyList.promise( obj );
};


var strundefined = typeof undefined;



// Support: IE<9
// Iteration over object's inherited properties before its own
var i;
for ( i in jQuery( support ) ) {
	break;
}
support.ownLast = i !== "0";

// Note: most support tests are defined in their respective modules.
// false until the test is run
support.inlineBlockNeedsLayout = false;

jQuery(function() {
	// We need to execute this one support test ASAP because we need to know
	// if body.style.zoom needs to be set.

	var container, div,
		body = document.getElementsByTagName("body")[0];

	if ( !body ) {
		// Return for frameset docs that don't have a body
		return;
	}

	// Setup
	container = document.createElement( "div" );
	container.style.cssText = "border:0;width:0;height:0;position:absolute;top:0;left:-9999px;margin-top:1px";

	div = document.createElement( "div" );
	body.appendChild( container ).appendChild( div );

	if ( typeof div.style.zoom !== strundefined ) {
		// Support: IE<8
		// Check if natively block-level elements act like inline-block
		// elements when setting their display to 'inline' and giving
		// them layout
		div.style.cssText = "border:0;margin:0;width:1px;padding:1px;display:inline;zoom:1";

		if ( (support.inlineBlockNeedsLayout = ( div.offsetWidth === 3 )) ) {
			// Prevent IE 6 from affecting layout for positioned elements #11048
			// Prevent IE from shrinking the body in IE 7 mode #12869
			// Support: IE<8
			body.style.zoom = 1;
		}
	}

	body.removeChild( container );

	// Null elements to avoid leaks in IE
	container = div = null;
});




(function() {
	var div = document.createElement( "div" );

	// Execute the test only if not already executed in another module.
	if (support.deleteExpando == null) {
		// Support: IE<9
		support.deleteExpando = true;
		try {
			delete div.test;
		} catch( e ) {
			support.deleteExpando = false;
		}
	}

	// Null elements to avoid leaks in IE.
	div = null;
})();


/**
 * Determines whether an object can have data
 */
jQuery.acceptData = function( elem ) {
	var noData = jQuery.noData[ (elem.nodeName + " ").toLowerCase() ],
		nodeType = +elem.nodeType || 1;

	// Do not set data on non-element DOM nodes because it will not be cleared (#8335).
	return nodeType !== 1 && nodeType !== 9 ?
		false :

		// Nodes accept data unless otherwise specified; rejection can be conditional
		!noData || noData !== true && elem.getAttribute("classid") === noData;
};


var rbrace = /^(?:\{[\w\W]*\}|\[[\w\W]*\])$/,
	rmultiDash = /([A-Z])/g;

function dataAttr( elem, key, data ) {
	// If nothing was found internally, try to fetch any
	// data from the HTML5 data-* attribute
	if ( data === undefined && elem.nodeType === 1 ) {

		var name = "data-" + key.replace( rmultiDash, "-$1" ).toLowerCase();

		data = elem.getAttribute( name );

		if ( typeof data === "string" ) {
			try {
				data = data === "true" ? true :
					data === "false" ? false :
					data === "null" ? null :
					// Only convert to a number if it doesn't change the string
					+data + "" === data ? +data :
					rbrace.test( data ) ? jQuery.parseJSON( data ) :
					data;
			} catch( e ) {}

			// Make sure we set the data so it isn't changed later
			jQuery.data( elem, key, data );

		} else {
			data = undefined;
		}
	}

	return data;
}

// checks a cache object for emptiness
function isEmptyDataObject( obj ) {
	var name;
	for ( name in obj ) {

		// if the public data object is empty, the private is still empty
		if ( name === "data" && jQuery.isEmptyObject( obj[name] ) ) {
			continue;
		}
		if ( name !== "toJSON" ) {
			return false;
		}
	}

	return true;
}

function internalData( elem, name, data, pvt /* Internal Use Only */ ) {
	if ( !jQuery.acceptData( elem ) ) {
		return;
	}

	var ret, thisCache,
		internalKey = jQuery.expando,

		// We have to handle DOM nodes and JS objects differently because IE6-7
		// can't GC object references properly across the DOM-JS boundary
		isNode = elem.nodeType,

		// Only DOM nodes need the global jQuery cache; JS object data is
		// attached directly to the object so GC can occur automatically
		cache = isNode ? jQuery.cache : elem,

		// Only defining an ID for JS objects if its cache already exists allows
		// the code to shortcut on the same path as a DOM node with no cache
		id = isNode ? elem[ internalKey ] : elem[ internalKey ] && internalKey;

	// Avoid doing any more work than we need to when trying to get data on an
	// object that has no data at all
	if ( (!id || !cache[id] || (!pvt && !cache[id].data)) && data === undefined && typeof name === "string" ) {
		return;
	}

	if ( !id ) {
		// Only DOM nodes need a new unique ID for each element since their data
		// ends up in the global cache
		if ( isNode ) {
			id = elem[ internalKey ] = deletedIds.pop() || jQuery.guid++;
		} else {
			id = internalKey;
		}
	}

	if ( !cache[ id ] ) {
		// Avoid exposing jQuery metadata on plain JS objects when the object
		// is serialized using JSON.stringify
		cache[ id ] = isNode ? {} : { toJSON: jQuery.noop };
	}

	// An object can be passed to jQuery.data instead of a key/value pair; this gets
	// shallow copied over onto the existing cache
	if ( typeof name === "object" || typeof name === "function" ) {
		if ( pvt ) {
			cache[ id ] = jQuery.extend( cache[ id ], name );
		} else {
			cache[ id ].data = jQuery.extend( cache[ id ].data, name );
		}
	}

	thisCache = cache[ id ];

	// jQuery data() is stored in a separate object inside the object's internal data
	// cache in order to avoid key collisions between internal data and user-defined
	// data.
	if ( !pvt ) {
		if ( !thisCache.data ) {
			thisCache.data = {};
		}

		thisCache = thisCache.data;
	}

	if ( data !== undefined ) {
		thisCache[ jQuery.camelCase( name ) ] = data;
	}

	// Check for both converted-to-camel and non-converted data property names
	// If a data property was specified
	if ( typeof name === "string" ) {

		// First Try to find as-is property data
		ret = thisCache[ name ];

		// Test for null|undefined property data
		if ( ret == null ) {

			// Try to find the camelCased property
			ret = thisCache[ jQuery.camelCase( name ) ];
		}
	} else {
		ret = thisCache;
	}

	return ret;
}

function internalRemoveData( elem, name, pvt ) {
	if ( !jQuery.acceptData( elem ) ) {
		return;
	}

	var thisCache, i,
		isNode = elem.nodeType,

		// See jQuery.data for more information
		cache = isNode ? jQuery.cache : elem,
		id = isNode ? elem[ jQuery.expando ] : jQuery.expando;

	// If there is already no cache entry for this object, there is no
	// purpose in continuing
	if ( !cache[ id ] ) {
		return;
	}

	if ( name ) {

		thisCache = pvt ? cache[ id ] : cache[ id ].data;

		if ( thisCache ) {

			// Support array or space separated string names for data keys
			if ( !jQuery.isArray( name ) ) {

				// try the string as a key before any manipulation
				if ( name in thisCache ) {
					name = [ name ];
				} else {

					// split the camel cased version by spaces unless a key with the spaces exists
					name = jQuery.camelCase( name );
					if ( name in thisCache ) {
						name = [ name ];
					} else {
						name = name.split(" ");
					}
				}
			} else {
				// If "name" is an array of keys...
				// When data is initially created, via ("key", "val") signature,
				// keys will be converted to camelCase.
				// Since there is no way to tell _how_ a key was added, remove
				// both plain key and camelCase key. #12786
				// This will only penalize the array argument path.
				name = name.concat( jQuery.map( name, jQuery.camelCase ) );
			}

			i = name.length;
			while ( i-- ) {
				delete thisCache[ name[i] ];
			}

			// If there is no data left in the cache, we want to continue
			// and let the cache object itself get destroyed
			if ( pvt ? !isEmptyDataObject(thisCache) : !jQuery.isEmptyObject(thisCache) ) {
				return;
			}
		}
	}

	// See jQuery.data for more information
	if ( !pvt ) {
		delete cache[ id ].data;

		// Don't destroy the parent cache unless the internal data object
		// had been the only thing left in it
		if ( !isEmptyDataObject( cache[ id ] ) ) {
			return;
		}
	}

	// Destroy the cache
	if ( isNode ) {
		jQuery.cleanData( [ elem ], true );

	// Use delete when supported for expandos or `cache` is not a window per isWindow (#10080)
	/* jshint eqeqeq: false */
	} else if ( support.deleteExpando || cache != cache.window ) {
		/* jshint eqeqeq: true */
		delete cache[ id ];

	// When all else fails, null
	} else {
		cache[ id ] = null;
	}
}

jQuery.extend({
	cache: {},

	// The following elements (space-suffixed to avoid Object.prototype collisions)
	// throw uncatchable exceptions if you attempt to set expando properties
	noData: {
		"applet ": true,
		"embed ": true,
		// ...but Flash objects (which have this classid) *can* handle expandos
		"object ": "clsid:D27CDB6E-AE6D-11cf-96B8-444553540000"
	},

	hasData: function( elem ) {
		elem = elem.nodeType ? jQuery.cache[ elem[jQuery.expando] ] : elem[ jQuery.expando ];
		return !!elem && !isEmptyDataObject( elem );
	},

	data: function( elem, name, data ) {
		return internalData( elem, name, data );
	},

	removeData: function( elem, name ) {
		return internalRemoveData( elem, name );
	},

	// For internal use only.
	_data: function( elem, name, data ) {
		return internalData( elem, name, data, true );
	},

	_removeData: function( elem, name ) {
		return internalRemoveData( elem, name, true );
	}
});

jQuery.fn.extend({
	data: function( key, value ) {
		var i, name, data,
			elem = this[0],
			attrs = elem && elem.attributes;

		// Special expections of .data basically thwart jQuery.access,
		// so implement the relevant behavior ourselves

		// Gets all values
		if ( key === undefined ) {
			if ( this.length ) {
				data = jQuery.data( elem );

				if ( elem.nodeType === 1 && !jQuery._data( elem, "parsedAttrs" ) ) {
					i = attrs.length;
					while ( i-- ) {
						name = attrs[i].name;

						if ( name.indexOf("data-") === 0 ) {
							name = jQuery.camelCase( name.slice(5) );

							dataAttr( elem, name, data[ name ] );
						}
					}
					jQuery._data( elem, "parsedAttrs", true );
				}
			}

			return data;
		}

		// Sets multiple values
		if ( typeof key === "object" ) {
			return this.each(function() {
				jQuery.data( this, key );
			});
		}

		return arguments.length > 1 ?

			// Sets one value
			this.each(function() {
				jQuery.data( this, key, value );
			}) :

			// Gets one value
			// Try to fetch any internally stored data first
			elem ? dataAttr( elem, key, jQuery.data( elem, key ) ) : undefined;
	},

	removeData: function( key ) {
		return this.each(function() {
			jQuery.removeData( this, key );
		});
	}
});


jQuery.extend({
	queue: function( elem, type, data ) {
		var queue;

		if ( elem ) {
			type = ( type || "fx" ) + "queue";
			queue = jQuery._data( elem, type );

			// Speed up dequeue by getting out quickly if this is just a lookup
			if ( data ) {
				if ( !queue || jQuery.isArray(data) ) {
					queue = jQuery._data( elem, type, jQuery.makeArray(data) );
				} else {
					queue.push( data );
				}
			}
			return queue || [];
		}
	},

	dequeue: function( elem, type ) {
		type = type || "fx";

		var queue = jQuery.queue( elem, type ),
			startLength = queue.length,
			fn = queue.shift(),
			hooks = jQuery._queueHooks( elem, type ),
			next = function() {
				jQuery.dequeue( elem, type );
			};

		// If the fx queue is dequeued, always remove the progress sentinel
		if ( fn === "inprogress" ) {
			fn = queue.shift();
			startLength--;
		}

		if ( fn ) {

			// Add a progress sentinel to prevent the fx queue from being
			// automatically dequeued
			if ( type === "fx" ) {
				queue.unshift( "inprogress" );
			}

			// clear up the last queue stop function
			delete hooks.stop;
			fn.call( elem, next, hooks );
		}

		if ( !startLength && hooks ) {
			hooks.empty.fire();
		}
	},

	// not intended for public consumption - generates a queueHooks object, or returns the current one
	_queueHooks: function( elem, type ) {
		var key = type + "queueHooks";
		return jQuery._data( elem, key ) || jQuery._data( elem, key, {
			empty: jQuery.Callbacks("once memory").add(function() {
				jQuery._removeData( elem, type + "queue" );
				jQuery._removeData( elem, key );
			})
		});
	}
});

jQuery.fn.extend({
	queue: function( type, data ) {
		var setter = 2;

		if ( typeof type !== "string" ) {
			data = type;
			type = "fx";
			setter--;
		}

		if ( arguments.length < setter ) {
			return jQuery.queue( this[0], type );
		}

		return data === undefined ?
			this :
			this.each(function() {
				var queue = jQuery.queue( this, type, data );

				// ensure a hooks for this queue
				jQuery._queueHooks( this, type );

				if ( type === "fx" && queue[0] !== "inprogress" ) {
					jQuery.dequeue( this, type );
				}
			});
	},
	dequeue: function( type ) {
		return this.each(function() {
			jQuery.dequeue( this, type );
		});
	},
	clearQueue: function( type ) {
		return this.queue( type || "fx", [] );
	},
	// Get a promise resolved when queues of a certain type
	// are emptied (fx is the type by default)
	promise: function( type, obj ) {
		var tmp,
			count = 1,
			defer = jQuery.Deferred(),
			elements = this,
			i = this.length,
			resolve = function() {
				if ( !( --count ) ) {
					defer.resolveWith( elements, [ elements ] );
				}
			};

		if ( typeof type !== "string" ) {
			obj = type;
			type = undefined;
		}
		type = type || "fx";

		while ( i-- ) {
			tmp = jQuery._data( elements[ i ], type + "queueHooks" );
			if ( tmp && tmp.empty ) {
				count++;
				tmp.empty.add( resolve );
			}
		}
		resolve();
		return defer.promise( obj );
	}
});
var pnum = (/[+-]?(?:\d*\.|)\d+(?:[eE][+-]?\d+|)/).source;

var cssExpand = [ "Top", "Right", "Bottom", "Left" ];

var isHidden = function( elem, el ) {
		// isHidden might be called from jQuery#filter function;
		// in that case, element will be second argument
		elem = el || elem;
		return jQuery.css( elem, "display" ) === "none" || !jQuery.contains( elem.ownerDocument, elem );
	};



// Multifunctional method to get and set values of a collection
// The value/s can optionally be executed if it's a function
var access = jQuery.access = function( elems, fn, key, value, chainable, emptyGet, raw ) {
	var i = 0,
		length = elems.length,
		bulk = key == null;

	// Sets many values
	if ( jQuery.type( key ) === "object" ) {
		chainable = true;
		for ( i in key ) {
			jQuery.access( elems, fn, i, key[i], true, emptyGet, raw );
		}

	// Sets one value
	} else if ( value !== undefined ) {
		chainable = true;

		if ( !jQuery.isFunction( value ) ) {
			raw = true;
		}

		if ( bulk ) {
			// Bulk operations run against the entire set
			if ( raw ) {
				fn.call( elems, value );
				fn = null;

			// ...except when executing function values
			} else {
				bulk = fn;
				fn = function( elem, key, value ) {
					return bulk.call( jQuery( elem ), value );
				};
			}
		}

		if ( fn ) {
			for ( ; i < length; i++ ) {
				fn( elems[i], key, raw ? value : value.call( elems[i], i, fn( elems[i], key ) ) );
			}
		}
	}

	return chainable ?
		elems :

		// Gets
		bulk ?
			fn.call( elems ) :
			length ? fn( elems[0], key ) : emptyGet;
};
var rcheckableType = (/^(?:checkbox|radio)$/i);



(function() {
	var fragment = document.createDocumentFragment(),
		div = document.createElement("div"),
		input = document.createElement("input");

	// Setup
	div.setAttribute( "className", "t" );
	div.innerHTML = "  <link/><table></table><a href='/a'>a</a>";

	// IE strips leading whitespace when .innerHTML is used
	support.leadingWhitespace = div.firstChild.nodeType === 3;

	// Make sure that tbody elements aren't automatically inserted
	// IE will insert them into empty tables
	support.tbody = !div.getElementsByTagName( "tbody" ).length;

	// Make sure that link elements get serialized correctly by innerHTML
	// This requires a wrapper element in IE
	support.htmlSerialize = !!div.getElementsByTagName( "link" ).length;

	// Makes sure cloning an html5 element does not cause problems
	// Where outerHTML is undefined, this still works
	support.html5Clone =
		document.createElement( "nav" ).cloneNode( true ).outerHTML !== "<:nav></:nav>";

	// Check if a disconnected checkbox will retain its checked
	// value of true after appended to the DOM (IE6/7)
	input.type = "checkbox";
	input.checked = true;
	fragment.appendChild( input );
	support.appendChecked = input.checked;

	// Make sure textarea (and checkbox) defaultValue is properly cloned
	// Support: IE6-IE11+
	div.innerHTML = "<textarea>x</textarea>";
	support.noCloneChecked = !!div.cloneNode( true ).lastChild.defaultValue;

	// #11217 - WebKit loses check when the name is after the checked attribute
	fragment.appendChild( div );
	div.innerHTML = "<input type='radio' checked='checked' name='t'/>";

	// Support: Safari 5.1, iOS 5.1, Android 4.x, Android 2.3
	// old WebKit doesn't clone checked state correctly in fragments
	support.checkClone = div.cloneNode( true ).cloneNode( true ).lastChild.checked;

	// Support: IE<9
	// Opera does not clone events (and typeof div.attachEvent === undefined).
	// IE9-10 clones events bound via attachEvent, but they don't trigger with .click()
	support.noCloneEvent = true;
	if ( div.attachEvent ) {
		div.attachEvent( "onclick", function() {
			support.noCloneEvent = false;
		});

		div.cloneNode( true ).click();
	}

	// Execute the test only if not already executed in another module.
	if (support.deleteExpando == null) {
		// Support: IE<9
		support.deleteExpando = true;
		try {
			delete div.test;
		} catch( e ) {
			support.deleteExpando = false;
		}
	}

	// Null elements to avoid leaks in IE.
	fragment = div = input = null;
})();


(function() {
	var i, eventName,
		div = document.createElement( "div" );

	// Support: IE<9 (lack submit/change bubble), Firefox 23+ (lack focusin event)
	for ( i in { submit: true, change: true, focusin: true }) {
		eventName = "on" + i;

		if ( !(support[ i + "Bubbles" ] = eventName in window) ) {
			// Beware of CSP restrictions (https://developer.mozilla.org/en/Security/CSP)
			div.setAttribute( eventName, "t" );
			support[ i + "Bubbles" ] = div.attributes[ eventName ].expando === false;
		}
	}

	// Null elements to avoid leaks in IE.
	div = null;
})();


var rformElems = /^(?:input|select|textarea)$/i,
	rkeyEvent = /^key/,
	rmouseEvent = /^(?:mouse|contextmenu)|click/,
	rfocusMorph = /^(?:focusinfocus|focusoutblur)$/,
	rtypenamespace = /^([^.]*)(?:\.(.+)|)$/;

function returnTrue() {
	return true;
}

function returnFalse() {
	return false;
}

function safeActiveElement() {
	try {
		return document.activeElement;
	} catch ( err ) { }
}

/*
 * Helper functions for managing events -- not part of the public interface.
 * Props to Dean Edwards' addEvent library for many of the ideas.
 */
jQuery.event = {

	global: {},

	add: function( elem, types, handler, data, selector ) {
		var tmp, events, t, handleObjIn,
			special, eventHandle, handleObj,
			handlers, type, namespaces, origType,
			elemData = jQuery._data( elem );

		// Don't attach events to noData or text/comment nodes (but allow plain objects)
		if ( !elemData ) {
			return;
		}

		// Caller can pass in an object of custom data in lieu of the handler
		if ( handler.handler ) {
			handleObjIn = handler;
			handler = handleObjIn.handler;
			selector = handleObjIn.selector;
		}

		// Make sure that the handler has a unique ID, used to find/remove it later
		if ( !handler.guid ) {
			handler.guid = jQuery.guid++;
		}

		// Init the element's event structure and main handler, if this is the first
		if ( !(events = elemData.events) ) {
			events = elemData.events = {};
		}
		if ( !(eventHandle = elemData.handle) ) {
			eventHandle = elemData.handle = function( e ) {
				// Discard the second event of a jQuery.event.trigger() and
				// when an event is called after a page has unloaded
				return typeof jQuery !== strundefined && (!e || jQuery.event.triggered !== e.type) ?
					jQuery.event.dispatch.apply( eventHandle.elem, arguments ) :
					undefined;
			};
			// Add elem as a property of the handle fn to prevent a memory leak with IE non-native events
			eventHandle.elem = elem;
		}

		// Handle multiple events separated by a space
		types = ( types || "" ).match( rnotwhite ) || [ "" ];
		t = types.length;
		while ( t-- ) {
			tmp = rtypenamespace.exec( types[t] ) || [];
			type = origType = tmp[1];
			namespaces = ( tmp[2] || "" ).split( "." ).sort();

			// There *must* be a type, no attaching namespace-only handlers
			if ( !type ) {
				continue;
			}

			// If event changes its type, use the special event handlers for the changed type
			special = jQuery.event.special[ type ] || {};

			// If selector defined, determine special event api type, otherwise given type
			type = ( selector ? special.delegateType : special.bindType ) || type;

			// Update special based on newly reset type
			special = jQuery.event.special[ type ] || {};

			// handleObj is passed to all event handlers
			handleObj = jQuery.extend({
				type: type,
				origType: origType,
				data: data,
				handler: handler,
				guid: handler.guid,
				selector: selector,
				needsContext: selector && jQuery.expr.match.needsContext.test( selector ),
				namespace: namespaces.join(".")
			}, handleObjIn );

			// Init the event handler queue if we're the first
			if ( !(handlers = events[ type ]) ) {
				handlers = events[ type ] = [];
				handlers.delegateCount = 0;

				// Only use addEventListener/attachEvent if the special events handler returns false
				if ( !special.setup || special.setup.call( elem, data, namespaces, eventHandle ) === false ) {
					// Bind the global event handler to the element
					if ( elem.addEventListener ) {
						elem.addEventListener( type, eventHandle, false );

					} else if ( elem.attachEvent ) {
						elem.attachEvent( "on" + type, eventHandle );
					}
				}
			}

			if ( special.add ) {
				special.add.call( elem, handleObj );

				if ( !handleObj.handler.guid ) {
					handleObj.handler.guid = handler.guid;
				}
			}

			// Add to the element's handler list, delegates in front
			if ( selector ) {
				handlers.splice( handlers.delegateCount++, 0, handleObj );
			} else {
				handlers.push( handleObj );
			}

			// Keep track of which events have ever been used, for event optimization
			jQuery.event.global[ type ] = true;
		}

		// Nullify elem to prevent memory leaks in IE
		elem = null;
	},

	// Detach an event or set of events from an element
	remove: function( elem, types, handler, selector, mappedTypes ) {
		var j, handleObj, tmp,
			origCount, t, events,
			special, handlers, type,
			namespaces, origType,
			elemData = jQuery.hasData( elem ) && jQuery._data( elem );

		if ( !elemData || !(events = elemData.events) ) {
			return;
		}

		// Once for each type.namespace in types; type may be omitted
		types = ( types || "" ).match( rnotwhite ) || [ "" ];
		t = types.length;
		while ( t-- ) {
			tmp = rtypenamespace.exec( types[t] ) || [];
			type = origType = tmp[1];
			namespaces = ( tmp[2] || "" ).split( "." ).sort();

			// Unbind all events (on this namespace, if provided) for the element
			if ( !type ) {
				for ( type in events ) {
					jQuery.event.remove( elem, type + types[ t ], handler, selector, true );
				}
				continue;
			}

			special = jQuery.event.special[ type ] || {};
			type = ( selector ? special.delegateType : special.bindType ) || type;
			handlers = events[ type ] || [];
			tmp = tmp[2] && new RegExp( "(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)" );

			// Remove matching events
			origCount = j = handlers.length;
			while ( j-- ) {
				handleObj = handlers[ j ];

				if ( ( mappedTypes || origType === handleObj.origType ) &&
					( !handler || handler.guid === handleObj.guid ) &&
					( !tmp || tmp.test( handleObj.namespace ) ) &&
					( !selector || selector === handleObj.selector || selector === "**" && handleObj.selector ) ) {
					handlers.splice( j, 1 );

					if ( handleObj.selector ) {
						handlers.delegateCount--;
					}
					if ( special.remove ) {
						special.remove.call( elem, handleObj );
					}
				}
			}

			// Remove generic event handler if we removed something and no more handlers exist
			// (avoids potential for endless recursion during removal of special event handlers)
			if ( origCount && !handlers.length ) {
				if ( !special.teardown || special.teardown.call( elem, namespaces, elemData.handle ) === false ) {
					jQuery.removeEvent( elem, type, elemData.handle );
				}

				delete events[ type ];
			}
		}

		// Remove the expando if it's no longer used
		if ( jQuery.isEmptyObject( events ) ) {
			delete elemData.handle;

			// removeData also checks for emptiness and clears the expando if empty
			// so use it instead of delete
			jQuery._removeData( elem, "events" );
		}
	},

	trigger: function( event, data, elem, onlyHandlers ) {
		var handle, ontype, cur,
			bubbleType, special, tmp, i,
			eventPath = [ elem || document ],
			type = hasOwn.call( event, "type" ) ? event.type : event,
			namespaces = hasOwn.call( event, "namespace" ) ? event.namespace.split(".") : [];

		cur = tmp = elem = elem || document;

		// Don't do events on text and comment nodes
		if ( elem.nodeType === 3 || elem.nodeType === 8 ) {
			return;
		}

		// focus/blur morphs to focusin/out; ensure we're not firing them right now
		if ( rfocusMorph.test( type + jQuery.event.triggered ) ) {
			return;
		}

		if ( type.indexOf(".") >= 0 ) {
			// Namespaced trigger; create a regexp to match event type in handle()
			namespaces = type.split(".");
			type = namespaces.shift();
			namespaces.sort();
		}
		ontype = type.indexOf(":") < 0 && "on" + type;

		// Caller can pass in a jQuery.Event object, Object, or just an event type string
		event = event[ jQuery.expando ] ?
			event :
			new jQuery.Event( type, typeof event === "object" && event );

		// Trigger bitmask: & 1 for native handlers; & 2 for jQuery (always true)
		event.isTrigger = onlyHandlers ? 2 : 3;
		event.namespace = namespaces.join(".");
		event.namespace_re = event.namespace ?
			new RegExp( "(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)" ) :
			null;

		// Clean up the event in case it is being reused
		event.result = undefined;
		if ( !event.target ) {
			event.target = elem;
		}

		// Clone any incoming data and prepend the event, creating the handler arg list
		data = data == null ?
			[ event ] :
			jQuery.makeArray( data, [ event ] );

		// Allow special events to draw outside the lines
		special = jQuery.event.special[ type ] || {};
		if ( !onlyHandlers && special.trigger && special.trigger.apply( elem, data ) === false ) {
			return;
		}

		// Determine event propagation path in advance, per W3C events spec (#9951)
		// Bubble up to document, then to window; watch for a global ownerDocument var (#9724)
		if ( !onlyHandlers && !special.noBubble && !jQuery.isWindow( elem ) ) {

			bubbleType = special.delegateType || type;
			if ( !rfocusMorph.test( bubbleType + type ) ) {
				cur = cur.parentNode;
			}
			for ( ; cur; cur = cur.parentNode ) {
				eventPath.push( cur );
				tmp = cur;
			}

			// Only add window if we got to document (e.g., not plain obj or detached DOM)
			if ( tmp === (elem.ownerDocument || document) ) {
				eventPath.push( tmp.defaultView || tmp.parentWindow || window );
			}
		}

		// Fire handlers on the event path
		i = 0;
		while ( (cur = eventPath[i++]) && !event.isPropagationStopped() ) {

			event.type = i > 1 ?
				bubbleType :
				special.bindType || type;

			// jQuery handler
			handle = ( jQuery._data( cur, "events" ) || {} )[ event.type ] && jQuery._data( cur, "handle" );
			if ( handle ) {
				handle.apply( cur, data );
			}

			// Native handler
			handle = ontype && cur[ ontype ];
			if ( handle && handle.apply && jQuery.acceptData( cur ) ) {
				event.result = handle.apply( cur, data );
				if ( event.result === false ) {
					event.preventDefault();
				}
			}
		}
		event.type = type;

		// If nobody prevented the default action, do it now
		if ( !onlyHandlers && !event.isDefaultPrevented() ) {

			if ( (!special._default || special._default.apply( eventPath.pop(), data ) === false) &&
				jQuery.acceptData( elem ) ) {

				// Call a native DOM method on the target with the same name name as the event.
				// Can't use an .isFunction() check here because IE6/7 fails that test.
				// Don't do default actions on window, that's where global variables be (#6170)
				if ( ontype && elem[ type ] && !jQuery.isWindow( elem ) ) {

					// Don't re-trigger an onFOO event when we call its FOO() method
					tmp = elem[ ontype ];

					if ( tmp ) {
						elem[ ontype ] = null;
					}

					// Prevent re-triggering of the same event, since we already bubbled it above
					jQuery.event.triggered = type;
					try {
						elem[ type ]();
					} catch ( e ) {
						// IE<9 dies on focus/blur to hidden element (#1486,#12518)
						// only reproducible on winXP IE8 native, not IE9 in IE8 mode
					}
					jQuery.event.triggered = undefined;

					if ( tmp ) {
						elem[ ontype ] = tmp;
					}
				}
			}
		}

		return event.result;
	},

	dispatch: function( event ) {

		// Make a writable jQuery.Event from the native event object
		event = jQuery.event.fix( event );

		var i, ret, handleObj, matched, j,
			handlerQueue = [],
			args = slice.call( arguments ),
			handlers = ( jQuery._data( this, "events" ) || {} )[ event.type ] || [],
			special = jQuery.event.special[ event.type ] || {};

		// Use the fix-ed jQuery.Event rather than the (read-only) native event
		args[0] = event;
		event.delegateTarget = this;

		// Call the preDispatch hook for the mapped type, and let it bail if desired
		if ( special.preDispatch && special.preDispatch.call( this, event ) === false ) {
			return;
		}

		// Determine handlers
		handlerQueue = jQuery.event.handlers.call( this, event, handlers );

		// Run delegates first; they may want to stop propagation beneath us
		i = 0;
		while ( (matched = handlerQueue[ i++ ]) && !event.isPropagationStopped() ) {
			event.currentTarget = matched.elem;

			j = 0;
			while ( (handleObj = matched.handlers[ j++ ]) && !event.isImmediatePropagationStopped() ) {

				// Triggered event must either 1) have no namespace, or
				// 2) have namespace(s) a subset or equal to those in the bound event (both can have no namespace).
				if ( !event.namespace_re || event.namespace_re.test( handleObj.namespace ) ) {

					event.handleObj = handleObj;
					event.data = handleObj.data;

					ret = ( (jQuery.event.special[ handleObj.origType ] || {}).handle || handleObj.handler )
							.apply( matched.elem, args );

					if ( ret !== undefined ) {
						if ( (event.result = ret) === false ) {
							event.preventDefault();
							event.stopPropagation();
						}
					}
				}
			}
		}

		// Call the postDispatch hook for the mapped type
		if ( special.postDispatch ) {
			special.postDispatch.call( this, event );
		}

		return event.result;
	},

	handlers: function( event, handlers ) {
		var sel, handleObj, matches, i,
			handlerQueue = [],
			delegateCount = handlers.delegateCount,
			cur = event.target;

		// Find delegate handlers
		// Black-hole SVG <use> instance trees (#13180)
		// Avoid non-left-click bubbling in Firefox (#3861)
		if ( delegateCount && cur.nodeType && (!event.button || event.type !== "click") ) {

			/* jshint eqeqeq: false */
			for ( ; cur != this; cur = cur.parentNode || this ) {
				/* jshint eqeqeq: true */

				// Don't check non-elements (#13208)
				// Don't process clicks on disabled elements (#6911, #8165, #11382, #11764)
				if ( cur.nodeType === 1 && (cur.disabled !== true || event.type !== "click") ) {
					matches = [];
					for ( i = 0; i < delegateCount; i++ ) {
						handleObj = handlers[ i ];

						// Don't conflict with Object.prototype properties (#13203)
						sel = handleObj.selector + " ";

						if ( matches[ sel ] === undefined ) {
							matches[ sel ] = handleObj.needsContext ?
								jQuery( sel, this ).index( cur ) >= 0 :
								jQuery.find( sel, this, null, [ cur ] ).length;
						}
						if ( matches[ sel ] ) {
							matches.push( handleObj );
						}
					}
					if ( matches.length ) {
						handlerQueue.push({ elem: cur, handlers: matches });
					}
				}
			}
		}

		// Add the remaining (directly-bound) handlers
		if ( delegateCount < handlers.length ) {
			handlerQueue.push({ elem: this, handlers: handlers.slice( delegateCount ) });
		}

		return handlerQueue;
	},

	fix: function( event ) {
		if ( event[ jQuery.expando ] ) {
			return event;
		}

		// Create a writable copy of the event object and normalize some properties
		var i, prop, copy,
			type = event.type,
			originalEvent = event,
			fixHook = this.fixHooks[ type ];

		if ( !fixHook ) {
			this.fixHooks[ type ] = fixHook =
				rmouseEvent.test( type ) ? this.mouseHooks :
				rkeyEvent.test( type ) ? this.keyHooks :
				{};
		}
		copy = fixHook.props ? this.props.concat( fixHook.props ) : this.props;

		event = new jQuery.Event( originalEvent );

		i = copy.length;
		while ( i-- ) {
			prop = copy[ i ];
			event[ prop ] = originalEvent[ prop ];
		}

		// Support: IE<9
		// Fix target property (#1925)
		if ( !event.target ) {
			event.target = originalEvent.srcElement || document;
		}

		// Support: Chrome 23+, Safari?
		// Target should not be a text node (#504, #13143)
		if ( event.target.nodeType === 3 ) {
			event.target = event.target.parentNode;
		}

		// Support: IE<9
		// For mouse/key events, metaKey==false if it's undefined (#3368, #11328)
		event.metaKey = !!event.metaKey;

		return fixHook.filter ? fixHook.filter( event, originalEvent ) : event;
	},

	// Includes some event props shared by KeyEvent and MouseEvent
	props: "altKey bubbles cancelable ctrlKey currentTarget eventPhase metaKey relatedTarget shiftKey target timeStamp view which".split(" "),

	fixHooks: {},

	keyHooks: {
		props: "char charCode key keyCode".split(" "),
		filter: function( event, original ) {

			// Add which for key events
			if ( event.which == null ) {
				event.which = original.charCode != null ? original.charCode : original.keyCode;
			}

			return event;
		}
	},

	mouseHooks: {
		props: "button buttons clientX clientY fromElement offsetX offsetY pageX pageY screenX screenY toElement".split(" "),
		filter: function( event, original ) {
			var body, eventDoc, doc,
				button = original.button,
				fromElement = original.fromElement;

			// Calculate pageX/Y if missing and clientX/Y available
			if ( event.pageX == null && original.clientX != null ) {
				eventDoc = event.target.ownerDocument || document;
				doc = eventDoc.documentElement;
				body = eventDoc.body;

				event.pageX = original.clientX + ( doc && doc.scrollLeft || body && body.scrollLeft || 0 ) - ( doc && doc.clientLeft || body && body.clientLeft || 0 );
				event.pageY = original.clientY + ( doc && doc.scrollTop  || body && body.scrollTop  || 0 ) - ( doc && doc.clientTop  || body && body.clientTop  || 0 );
			}

			// Add relatedTarget, if necessary
			if ( !event.relatedTarget && fromElement ) {
				event.relatedTarget = fromElement === event.target ? original.toElement : fromElement;
			}

			// Add which for click: 1 === left; 2 === middle; 3 === right
			// Note: button is not normalized, so don't use it
			if ( !event.which && button !== undefined ) {
				event.which = ( button & 1 ? 1 : ( button & 2 ? 3 : ( button & 4 ? 2 : 0 ) ) );
			}

			return event;
		}
	},

	special: {
		load: {
			// Prevent triggered image.load events from bubbling to window.load
			noBubble: true
		},
		focus: {
			// Fire native event if possible so blur/focus sequence is correct
			trigger: function() {
				if ( this !== safeActiveElement() && this.focus ) {
					try {
						this.focus();
						return false;
					} catch ( e ) {
						// Support: IE<9
						// If we error on focus to hidden element (#1486, #12518),
						// let .trigger() run the handlers
					}
				}
			},
			delegateType: "focusin"
		},
		blur: {
			trigger: function() {
				if ( this === safeActiveElement() && this.blur ) {
					this.blur();
					return false;
				}
			},
			delegateType: "focusout"
		},
		click: {
			// For checkbox, fire native event so checked state will be right
			trigger: function() {
				if ( jQuery.nodeName( this, "input" ) && this.type === "checkbox" && this.click ) {
					this.click();
					return false;
				}
			},

			// For cross-browser consistency, don't fire native .click() on links
			_default: function( event ) {
				return jQuery.nodeName( event.target, "a" );
			}
		},

		beforeunload: {
			postDispatch: function( event ) {

				// Even when returnValue equals to undefined Firefox will still show alert
				if ( event.result !== undefined ) {
					event.originalEvent.returnValue = event.result;
				}
			}
		}
	},

	simulate: function( type, elem, event, bubble ) {
		// Piggyback on a donor event to simulate a different one.
		// Fake originalEvent to avoid donor's stopPropagation, but if the
		// simulated event prevents default then we do the same on the donor.
		var e = jQuery.extend(
			new jQuery.Event(),
			event,
			{
				type: type,
				isSimulated: true,
				originalEvent: {}
			}
		);
		if ( bubble ) {
			jQuery.event.trigger( e, null, elem );
		} else {
			jQuery.event.dispatch.call( elem, e );
		}
		if ( e.isDefaultPrevented() ) {
			event.preventDefault();
		}
	}
};

jQuery.removeEvent = document.removeEventListener ?
	function( elem, type, handle ) {
		if ( elem.removeEventListener ) {
			elem.removeEventListener( type, handle, false );
		}
	} :
	function( elem, type, handle ) {
		var name = "on" + type;

		if ( elem.detachEvent ) {

			// #8545, #7054, preventing memory leaks for custom events in IE6-8
			// detachEvent needed property on element, by name of that event, to properly expose it to GC
			if ( typeof elem[ name ] === strundefined ) {
				elem[ name ] = null;
			}

			elem.detachEvent( name, handle );
		}
	};

jQuery.Event = function( src, props ) {
	// Allow instantiation without the 'new' keyword
	if ( !(this instanceof jQuery.Event) ) {
		return new jQuery.Event( src, props );
	}

	// Event object
	if ( src && src.type ) {
		this.originalEvent = src;
		this.type = src.type;

		// Events bubbling up the document may have been marked as prevented
		// by a handler lower down the tree; reflect the correct value.
		this.isDefaultPrevented = src.defaultPrevented ||
				src.defaultPrevented === undefined && (
				// Support: IE < 9
				src.returnValue === false ||
				// Support: Android < 4.0
				src.getPreventDefault && src.getPreventDefault() ) ?
			returnTrue :
			returnFalse;

	// Event type
	} else {
		this.type = src;
	}

	// Put explicitly provided properties onto the event object
	if ( props ) {
		jQuery.extend( this, props );
	}

	// Create a timestamp if incoming event doesn't have one
	this.timeStamp = src && src.timeStamp || jQuery.now();

	// Mark it as fixed
	this[ jQuery.expando ] = true;
};

// jQuery.Event is based on DOM3 Events as specified by the ECMAScript Language Binding
// http://www.w3.org/TR/2003/WD-DOM-Level-3-Events-20030331/ecma-script-binding.html
jQuery.Event.prototype = {
	isDefaultPrevented: returnFalse,
	isPropagationStopped: returnFalse,
	isImmediatePropagationStopped: returnFalse,

	preventDefault: function() {
		var e = this.originalEvent;

		this.isDefaultPrevented = returnTrue;
		if ( !e ) {
			return;
		}

		// If preventDefault exists, run it on the original event
		if ( e.preventDefault ) {
			e.preventDefault();

		// Support: IE
		// Otherwise set the returnValue property of the original event to false
		} else {
			e.returnValue = false;
		}
	},
	stopPropagation: function() {
		var e = this.originalEvent;

		this.isPropagationStopped = returnTrue;
		if ( !e ) {
			return;
		}
		// If stopPropagation exists, run it on the original event
		if ( e.stopPropagation ) {
			e.stopPropagation();
		}

		// Support: IE
		// Set the cancelBubble property of the original event to true
		e.cancelBubble = true;
	},
	stopImmediatePropagation: function() {
		this.isImmediatePropagationStopped = returnTrue;
		this.stopPropagation();
	}
};

// Create mouseenter/leave events using mouseover/out and event-time checks
jQuery.each({
	mouseenter: "mouseover",
	mouseleave: "mouseout"
}, function( orig, fix ) {
	jQuery.event.special[ orig ] = {
		delegateType: fix,
		bindType: fix,

		handle: function( event ) {
			var ret,
				target = this,
				related = event.relatedTarget,
				handleObj = event.handleObj;

			// For mousenter/leave call the handler if related is outside the target.
			// NB: No relatedTarget if the mouse left/entered the browser window
			if ( !related || (related !== target && !jQuery.contains( target, related )) ) {
				event.type = handleObj.origType;
				ret = handleObj.handler.apply( this, arguments );
				event.type = fix;
			}
			return ret;
		}
	};
});

// IE submit delegation
if ( !support.submitBubbles ) {

	jQuery.event.special.submit = {
		setup: function() {
			// Only need this for delegated form submit events
			if ( jQuery.nodeName( this, "form" ) ) {
				return false;
			}

			// Lazy-add a submit handler when a descendant form may potentially be submitted
			jQuery.event.add( this, "click._submit keypress._submit", function( e ) {
				// Node name check avoids a VML-related crash in IE (#9807)
				var elem = e.target,
					form = jQuery.nodeName( elem, "input" ) || jQuery.nodeName( elem, "button" ) ? elem.form : undefined;
				if ( form && !jQuery._data( form, "submitBubbles" ) ) {
					jQuery.event.add( form, "submit._submit", function( event ) {
						event._submit_bubble = true;
					});
					jQuery._data( form, "submitBubbles", true );
				}
			});
			// return undefined since we don't need an event listener
		},

		postDispatch: function( event ) {
			// If form was submitted by the user, bubble the event up the tree
			if ( event._submit_bubble ) {
				delete event._submit_bubble;
				if ( this.parentNode && !event.isTrigger ) {
					jQuery.event.simulate( "submit", this.parentNode, event, true );
				}
			}
		},

		teardown: function() {
			// Only need this for delegated form submit events
			if ( jQuery.nodeName( this, "form" ) ) {
				return false;
			}

			// Remove delegated handlers; cleanData eventually reaps submit handlers attached above
			jQuery.event.remove( this, "._submit" );
		}
	};
}

// IE change delegation and checkbox/radio fix
if ( !support.changeBubbles ) {

	jQuery.event.special.change = {

		setup: function() {

			if ( rformElems.test( this.nodeName ) ) {
				// IE doesn't fire change on a check/radio until blur; trigger it on click
				// after a propertychange. Eat the blur-change in special.change.handle.
				// This still fires onchange a second time for check/radio after blur.
				if ( this.type === "checkbox" || this.type === "radio" ) {
					jQuery.event.add( this, "propertychange._change", function( event ) {
						if ( event.originalEvent.propertyName === "checked" ) {
							this._just_changed = true;
						}
					});
					jQuery.event.add( this, "click._change", function( event ) {
						if ( this._just_changed && !event.isTrigger ) {
							this._just_changed = false;
						}
						// Allow triggered, simulated change events (#11500)
						jQuery.event.simulate( "change", this, event, true );
					});
				}
				return false;
			}
			// Delegated event; lazy-add a change handler on descendant inputs
			jQuery.event.add( this, "beforeactivate._change", function( e ) {
				var elem = e.target;

				if ( rformElems.test( elem.nodeName ) && !jQuery._data( elem, "changeBubbles" ) ) {
					jQuery.event.add( elem, "change._change", function( event ) {
						if ( this.parentNode && !event.isSimulated && !event.isTrigger ) {
							jQuery.event.simulate( "change", this.parentNode, event, true );
						}
					});
					jQuery._data( elem, "changeBubbles", true );
				}
			});
		},

		handle: function( event ) {
			var elem = event.target;

			// Swallow native change events from checkbox/radio, we already triggered them above
			if ( this !== elem || event.isSimulated || event.isTrigger || (elem.type !== "radio" && elem.type !== "checkbox") ) {
				return event.handleObj.handler.apply( this, arguments );
			}
		},

		teardown: function() {
			jQuery.event.remove( this, "._change" );

			return !rformElems.test( this.nodeName );
		}
	};
}

// Create "bubbling" focus and blur events
if ( !support.focusinBubbles ) {
	jQuery.each({ focus: "focusin", blur: "focusout" }, function( orig, fix ) {

		// Attach a single capturing handler on the document while someone wants focusin/focusout
		var handler = function( event ) {
				jQuery.event.simulate( fix, event.target, jQuery.event.fix( event ), true );
			};

		jQuery.event.special[ fix ] = {
			setup: function() {
				var doc = this.ownerDocument || this,
					attaches = jQuery._data( doc, fix );

				if ( !attaches ) {
					doc.addEventListener( orig, handler, true );
				}
				jQuery._data( doc, fix, ( attaches || 0 ) + 1 );
			},
			teardown: function() {
				var doc = this.ownerDocument || this,
					attaches = jQuery._data( doc, fix ) - 1;

				if ( !attaches ) {
					doc.removeEventListener( orig, handler, true );
					jQuery._removeData( doc, fix );
				} else {
					jQuery._data( doc, fix, attaches );
				}
			}
		};
	});
}

jQuery.fn.extend({

	on: function( types, selector, data, fn, /*INTERNAL*/ one ) {
		var type, origFn;

		// Types can be a map of types/handlers
		if ( typeof types === "object" ) {
			// ( types-Object, selector, data )
			if ( typeof selector !== "string" ) {
				// ( types-Object, data )
				data = data || selector;
				selector = undefined;
			}
			for ( type in types ) {
				this.on( type, selector, data, types[ type ], one );
			}
			return this;
		}

		if ( data == null && fn == null ) {
			// ( types, fn )
			fn = selector;
			data = selector = undefined;
		} else if ( fn == null ) {
			if ( typeof selector === "string" ) {
				// ( types, selector, fn )
				fn = data;
				data = undefined;
			} else {
				// ( types, data, fn )
				fn = data;
				data = selector;
				selector = undefined;
			}
		}
		if ( fn === false ) {
			fn = returnFalse;
		} else if ( !fn ) {
			return this;
		}

		if ( one === 1 ) {
			origFn = fn;
			fn = function( event ) {
				// Can use an empty set, since event contains the info
				jQuery().off( event );
				return origFn.apply( this, arguments );
			};
			// Use same guid so caller can remove using origFn
			fn.guid = origFn.guid || ( origFn.guid = jQuery.guid++ );
		}
		return this.each( function() {
			jQuery.event.add( this, types, fn, data, selector );
		});
	},
	one: function( types, selector, data, fn ) {
		return this.on( types, selector, data, fn, 1 );
	},
	off: function( types, selector, fn ) {
		var handleObj, type;
		if ( types && types.preventDefault && types.handleObj ) {
			// ( event )  dispatched jQuery.Event
			handleObj = types.handleObj;
			jQuery( types.delegateTarget ).off(
				handleObj.namespace ? handleObj.origType + "." + handleObj.namespace : handleObj.origType,
				handleObj.selector,
				handleObj.handler
			);
			return this;
		}
		if ( typeof types === "object" ) {
			// ( types-object [, selector] )
			for ( type in types ) {
				this.off( type, selector, types[ type ] );
			}
			return this;
		}
		if ( selector === false || typeof selector === "function" ) {
			// ( types [, fn] )
			fn = selector;
			selector = undefined;
		}
		if ( fn === false ) {
			fn = returnFalse;
		}
		return this.each(function() {
			jQuery.event.remove( this, types, fn, selector );
		});
	},

	trigger: function( type, data ) {
		return this.each(function() {
			jQuery.event.trigger( type, data, this );
		});
	},
	triggerHandler: function( type, data ) {
		var elem = this[0];
		if ( elem ) {
			return jQuery.event.trigger( type, data, elem, true );
		}
	}
});


function createSafeFragment( document ) {
	var list = nodeNames.split( "|" ),
		safeFrag = document.createDocumentFragment();

	if ( safeFrag.createElement ) {
		while ( list.length ) {
			safeFrag.createElement(
				list.pop()
			);
		}
	}
	return safeFrag;
}

var nodeNames = "abbr|article|aside|audio|bdi|canvas|data|datalist|details|figcaption|figure|footer|" +
		"header|hgroup|mark|meter|nav|output|progress|section|summary|time|video",
	rinlinejQuery = / jQuery\d+="(?:null|\d+)"/g,
	rnoshimcache = new RegExp("<(?:" + nodeNames + ")[\\s/>]", "i"),
	rleadingWhitespace = /^\s+/,
	rxhtmlTag = /<(?!area|br|col|embed|hr|img|input|link|meta|param)(([\w:]+)[^>]*)\/>/gi,
	rtagName = /<([\w:]+)/,
	rtbody = /<tbody/i,
	rhtml = /<|&#?\w+;/,
	rnoInnerhtml = /<(?:script|style|link)/i,
	// checked="checked" or checked
	rchecked = /checked\s*(?:[^=]|=\s*.checked.)/i,
	rscriptType = /^$|\/(?:java|ecma)script/i,
	rscriptTypeMasked = /^true\/(.*)/,
	rcleanScript = /^\s*<!(?:\[CDATA\[|--)|(?:\]\]|--)>\s*$/g,

	// We have to close these tags to support XHTML (#13200)
	wrapMap = {
		option: [ 1, "<select multiple='multiple'>", "</select>" ],
		legend: [ 1, "<fieldset>", "</fieldset>" ],
		area: [ 1, "<map>", "</map>" ],
		param: [ 1, "<object>", "</object>" ],
		thead: [ 1, "<table>", "</table>" ],
		tr: [ 2, "<table><tbody>", "</tbody></table>" ],
		col: [ 2, "<table><tbody></tbody><colgroup>", "</colgroup></table>" ],
		td: [ 3, "<table><tbody><tr>", "</tr></tbody></table>" ],

		// IE6-8 can't serialize link, script, style, or any html5 (NoScope) tags,
		// unless wrapped in a div with non-breaking characters in front of it.
		_default: support.htmlSerialize ? [ 0, "", "" ] : [ 1, "X<div>", "</div>"  ]
	},
	safeFragment = createSafeFragment( document ),
	fragmentDiv = safeFragment.appendChild( document.createElement("div") );

wrapMap.optgroup = wrapMap.option;
wrapMap.tbody = wrapMap.tfoot = wrapMap.colgroup = wrapMap.caption = wrapMap.thead;
wrapMap.th = wrapMap.td;

function getAll( context, tag ) {
	var elems, elem,
		i = 0,
		found = typeof context.getElementsByTagName !== strundefined ? context.getElementsByTagName( tag || "*" ) :
			typeof context.querySelectorAll !== strundefined ? context.querySelectorAll( tag || "*" ) :
			undefined;

	if ( !found ) {
		for ( found = [], elems = context.childNodes || context; (elem = elems[i]) != null; i++ ) {
			if ( !tag || jQuery.nodeName( elem, tag ) ) {
				found.push( elem );
			} else {
				jQuery.merge( found, getAll( elem, tag ) );
			}
		}
	}

	return tag === undefined || tag && jQuery.nodeName( context, tag ) ?
		jQuery.merge( [ context ], found ) :
		found;
}

// Used in buildFragment, fixes the defaultChecked property
function fixDefaultChecked( elem ) {
	if ( rcheckableType.test( elem.type ) ) {
		elem.defaultChecked = elem.checked;
	}
}

// Support: IE<8
// Manipulating tables requires a tbody
function manipulationTarget( elem, content ) {
	return jQuery.nodeName( elem, "table" ) &&
		jQuery.nodeName( content.nodeType !== 11 ? content : content.firstChild, "tr" ) ?

		elem.getElementsByTagName("tbody")[0] ||
			elem.appendChild( elem.ownerDocument.createElement("tbody") ) :
		elem;
}

// Replace/restore the type attribute of script elements for safe DOM manipulation
function disableScript( elem ) {
	elem.type = (jQuery.find.attr( elem, "type" ) !== null) + "/" + elem.type;
	return elem;
}
function restoreScript( elem ) {
	var match = rscriptTypeMasked.exec( elem.type );
	if ( match ) {
		elem.type = match[1];
	} else {
		elem.removeAttribute("type");
	}
	return elem;
}

// Mark scripts as having already been evaluated
function setGlobalEval( elems, refElements ) {
	var elem,
		i = 0;
	for ( ; (elem = elems[i]) != null; i++ ) {
		jQuery._data( elem, "globalEval", !refElements || jQuery._data( refElements[i], "globalEval" ) );
	}
}

function cloneCopyEvent( src, dest ) {

	if ( dest.nodeType !== 1 || !jQuery.hasData( src ) ) {
		return;
	}

	var type, i, l,
		oldData = jQuery._data( src ),
		curData = jQuery._data( dest, oldData ),
		events = oldData.events;

	if ( events ) {
		delete curData.handle;
		curData.events = {};

		for ( type in events ) {
			for ( i = 0, l = events[ type ].length; i < l; i++ ) {
				jQuery.event.add( dest, type, events[ type ][ i ] );
			}
		}
	}

	// make the cloned public data object a copy from the original
	if ( curData.data ) {
		curData.data = jQuery.extend( {}, curData.data );
	}
}

function fixCloneNodeIssues( src, dest ) {
	var nodeName, e, data;

	// We do not need to do anything for non-Elements
	if ( dest.nodeType !== 1 ) {
		return;
	}

	nodeName = dest.nodeName.toLowerCase();

	// IE6-8 copies events bound via attachEvent when using cloneNode.
	if ( !support.noCloneEvent && dest[ jQuery.expando ] ) {
		data = jQuery._data( dest );

		for ( e in data.events ) {
			jQuery.removeEvent( dest, e, data.handle );
		}

		// Event data gets referenced instead of copied if the expando gets copied too
		dest.removeAttribute( jQuery.expando );
	}

	// IE blanks contents when cloning scripts, and tries to evaluate newly-set text
	if ( nodeName === "script" && dest.text !== src.text ) {
		disableScript( dest ).text = src.text;
		restoreScript( dest );

	// IE6-10 improperly clones children of object elements using classid.
	// IE10 throws NoModificationAllowedError if parent is null, #12132.
	} else if ( nodeName === "object" ) {
		if ( dest.parentNode ) {
			dest.outerHTML = src.outerHTML;
		}

		// This path appears unavoidable for IE9. When cloning an object
		// element in IE9, the outerHTML strategy above is not sufficient.
		// If the src has innerHTML and the destination does not,
		// copy the src.innerHTML into the dest.innerHTML. #10324
		if ( support.html5Clone && ( src.innerHTML && !jQuery.trim(dest.innerHTML) ) ) {
			dest.innerHTML = src.innerHTML;
		}

	} else if ( nodeName === "input" && rcheckableType.test( src.type ) ) {
		// IE6-8 fails to persist the checked state of a cloned checkbox
		// or radio button. Worse, IE6-7 fail to give the cloned element
		// a checked appearance if the defaultChecked value isn't also set

		dest.defaultChecked = dest.checked = src.checked;

		// IE6-7 get confused and end up setting the value of a cloned
		// checkbox/radio button to an empty string instead of "on"
		if ( dest.value !== src.value ) {
			dest.value = src.value;
		}

	// IE6-8 fails to return the selected option to the default selected
	// state when cloning options
	} else if ( nodeName === "option" ) {
		dest.defaultSelected = dest.selected = src.defaultSelected;

	// IE6-8 fails to set the defaultValue to the correct value when
	// cloning other types of input fields
	} else if ( nodeName === "input" || nodeName === "textarea" ) {
		dest.defaultValue = src.defaultValue;
	}
}

jQuery.extend({
	clone: function( elem, dataAndEvents, deepDataAndEvents ) {
		var destElements, node, clone, i, srcElements,
			inPage = jQuery.contains( elem.ownerDocument, elem );

		if ( support.html5Clone || jQuery.isXMLDoc(elem) || !rnoshimcache.test( "<" + elem.nodeName + ">" ) ) {
			clone = elem.cloneNode( true );

		// IE<=8 does not properly clone detached, unknown element nodes
		} else {
			fragmentDiv.innerHTML = elem.outerHTML;
			fragmentDiv.removeChild( clone = fragmentDiv.firstChild );
		}

		if ( (!support.noCloneEvent || !support.noCloneChecked) &&
				(elem.nodeType === 1 || elem.nodeType === 11) && !jQuery.isXMLDoc(elem) ) {

			// We eschew Sizzle here for performance reasons: http://jsperf.com/getall-vs-sizzle/2
			destElements = getAll( clone );
			srcElements = getAll( elem );

			// Fix all IE cloning issues
			for ( i = 0; (node = srcElements[i]) != null; ++i ) {
				// Ensure that the destination node is not null; Fixes #9587
				if ( destElements[i] ) {
					fixCloneNodeIssues( node, destElements[i] );
				}
			}
		}

		// Copy the events from the original to the clone
		if ( dataAndEvents ) {
			if ( deepDataAndEvents ) {
				srcElements = srcElements || getAll( elem );
				destElements = destElements || getAll( clone );

				for ( i = 0; (node = srcElements[i]) != null; i++ ) {
					cloneCopyEvent( node, destElements[i] );
				}
			} else {
				cloneCopyEvent( elem, clone );
			}
		}

		// Preserve script evaluation history
		destElements = getAll( clone, "script" );
		if ( destElements.length > 0 ) {
			setGlobalEval( destElements, !inPage && getAll( elem, "script" ) );
		}

		destElements = srcElements = node = null;

		// Return the cloned set
		return clone;
	},

	buildFragment: function( elems, context, scripts, selection ) {
		var j, elem, contains,
			tmp, tag, tbody, wrap,
			l = elems.length,

			// Ensure a safe fragment
			safe = createSafeFragment( context ),

			nodes = [],
			i = 0;

		for ( ; i < l; i++ ) {
			elem = elems[ i ];

			if ( elem || elem === 0 ) {

				// Add nodes directly
				if ( jQuery.type( elem ) === "object" ) {
					jQuery.merge( nodes, elem.nodeType ? [ elem ] : elem );

				// Convert non-html into a text node
				} else if ( !rhtml.test( elem ) ) {
					nodes.push( context.createTextNode( elem ) );

				// Convert html into DOM nodes
				} else {
					tmp = tmp || safe.appendChild( context.createElement("div") );

					// Deserialize a standard representation
					tag = (rtagName.exec( elem ) || [ "", "" ])[ 1 ].toLowerCase();
					wrap = wrapMap[ tag ] || wrapMap._default;

					tmp.innerHTML = wrap[1] + elem.replace( rxhtmlTag, "<$1></$2>" ) + wrap[2];

					// Descend through wrappers to the right content
					j = wrap[0];
					while ( j-- ) {
						tmp = tmp.lastChild;
					}

					// Manually add leading whitespace removed by IE
					if ( !support.leadingWhitespace && rleadingWhitespace.test( elem ) ) {
						nodes.push( context.createTextNode( rleadingWhitespace.exec( elem )[0] ) );
					}

					// Remove IE's autoinserted <tbody> from table fragments
					if ( !support.tbody ) {

						// String was a <table>, *may* have spurious <tbody>
						elem = tag === "table" && !rtbody.test( elem ) ?
							tmp.firstChild :

							// String was a bare <thead> or <tfoot>
							wrap[1] === "<table>" && !rtbody.test( elem ) ?
								tmp :
								0;

						j = elem && elem.childNodes.length;
						while ( j-- ) {
							if ( jQuery.nodeName( (tbody = elem.childNodes[j]), "tbody" ) && !tbody.childNodes.length ) {
								elem.removeChild( tbody );
							}
						}
					}

					jQuery.merge( nodes, tmp.childNodes );

					// Fix #12392 for WebKit and IE > 9
					tmp.textContent = "";

					// Fix #12392 for oldIE
					while ( tmp.firstChild ) {
						tmp.removeChild( tmp.firstChild );
					}

					// Remember the top-level container for proper cleanup
					tmp = safe.lastChild;
				}
			}
		}

		// Fix #11356: Clear elements from fragment
		if ( tmp ) {
			safe.removeChild( tmp );
		}

		// Reset defaultChecked for any radios and checkboxes
		// about to be appended to the DOM in IE 6/7 (#8060)
		if ( !support.appendChecked ) {
			jQuery.grep( getAll( nodes, "input" ), fixDefaultChecked );
		}

		i = 0;
		while ( (elem = nodes[ i++ ]) ) {

			// #4087 - If origin and destination elements are the same, and this is
			// that element, do not do anything
			if ( selection && jQuery.inArray( elem, selection ) !== -1 ) {
				continue;
			}

			contains = jQuery.contains( elem.ownerDocument, elem );

			// Append to fragment
			tmp = getAll( safe.appendChild( elem ), "script" );

			// Preserve script evaluation history
			if ( contains ) {
				setGlobalEval( tmp );
			}

			// Capture executables
			if ( scripts ) {
				j = 0;
				while ( (elem = tmp[ j++ ]) ) {
					if ( rscriptType.test( elem.type || "" ) ) {
						scripts.push( elem );
					}
				}
			}
		}

		tmp = null;

		return safe;
	},

	cleanData: function( elems, /* internal */ acceptData ) {
		var elem, type, id, data,
			i = 0,
			internalKey = jQuery.expando,
			cache = jQuery.cache,
			deleteExpando = support.deleteExpando,
			special = jQuery.event.special;

		for ( ; (elem = elems[i]) != null; i++ ) {
			if ( acceptData || jQuery.acceptData( elem ) ) {

				id = elem[ internalKey ];
				data = id && cache[ id ];

				if ( data ) {
					if ( data.events ) {
						for ( type in data.events ) {
							if ( special[ type ] ) {
								jQuery.event.remove( elem, type );

							// This is a shortcut to avoid jQuery.event.remove's overhead
							} else {
								jQuery.removeEvent( elem, type, data.handle );
							}
						}
					}

					// Remove cache only if it was not already removed by jQuery.event.remove
					if ( cache[ id ] ) {

						delete cache[ id ];

						// IE does not allow us to delete expando properties from nodes,
						// nor does it have a removeAttribute function on Document nodes;
						// we must handle all of these cases
						if ( deleteExpando ) {
							delete elem[ internalKey ];

						} else if ( typeof elem.removeAttribute !== strundefined ) {
							elem.removeAttribute( internalKey );

						} else {
							elem[ internalKey ] = null;
						}

						deletedIds.push( id );
					}
				}
			}
		}
	}
});

jQuery.fn.extend({
	text: function( value ) {
		return access( this, function( value ) {
			return value === undefined ?
				jQuery.text( this ) :
				this.empty().append( ( this[0] && this[0].ownerDocument || document ).createTextNode( value ) );
		}, null, value, arguments.length );
	},

	append: function() {
		return this.domManip( arguments, function( elem ) {
			if ( this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9 ) {
				var target = manipulationTarget( this, elem );
				target.appendChild( elem );
			}
		});
	},

	prepend: function() {
		return this.domManip( arguments, function( elem ) {
			if ( this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9 ) {
				var target = manipulationTarget( this, elem );
				target.insertBefore( elem, target.firstChild );
			}
		});
	},

	before: function() {
		return this.domManip( arguments, function( elem ) {
			if ( this.parentNode ) {
				this.parentNode.insertBefore( elem, this );
			}
		});
	},

	after: function() {
		return this.domManip( arguments, function( elem ) {
			if ( this.parentNode ) {
				this.parentNode.insertBefore( elem, this.nextSibling );
			}
		});
	},

	remove: function( selector, keepData /* Internal Use Only */ ) {
		var elem,
			elems = selector ? jQuery.filter( selector, this ) : this,
			i = 0;

		for ( ; (elem = elems[i]) != null; i++ ) {

			if ( !keepData && elem.nodeType === 1 ) {
				jQuery.cleanData( getAll( elem ) );
			}

			if ( elem.parentNode ) {
				if ( keepData && jQuery.contains( elem.ownerDocument, elem ) ) {
					setGlobalEval( getAll( elem, "script" ) );
				}
				elem.parentNode.removeChild( elem );
			}
		}

		return this;
	},

	empty: function() {
		var elem,
			i = 0;

		for ( ; (elem = this[i]) != null; i++ ) {
			// Remove element nodes and prevent memory leaks
			if ( elem.nodeType === 1 ) {
				jQuery.cleanData( getAll( elem, false ) );
			}

			// Remove any remaining nodes
			while ( elem.firstChild ) {
				elem.removeChild( elem.firstChild );
			}

			// If this is a select, ensure that it displays empty (#12336)
			// Support: IE<9
			if ( elem.options && jQuery.nodeName( elem, "select" ) ) {
				elem.options.length = 0;
			}
		}

		return this;
	},

	clone: function( dataAndEvents, deepDataAndEvents ) {
		dataAndEvents = dataAndEvents == null ? false : dataAndEvents;
		deepDataAndEvents = deepDataAndEvents == null ? dataAndEvents : deepDataAndEvents;

		return this.map(function() {
			return jQuery.clone( this, dataAndEvents, deepDataAndEvents );
		});
	},

	html: function( value ) {
		return access( this, function( value ) {
			var elem = this[ 0 ] || {},
				i = 0,
				l = this.length;

			if ( value === undefined ) {
				return elem.nodeType === 1 ?
					elem.innerHTML.replace( rinlinejQuery, "" ) :
					undefined;
			}

			// See if we can take a shortcut and just use innerHTML
			if ( typeof value === "string" && !rnoInnerhtml.test( value ) &&
				( support.htmlSerialize || !rnoshimcache.test( value )  ) &&
				( support.leadingWhitespace || !rleadingWhitespace.test( value ) ) &&
				!wrapMap[ (rtagName.exec( value ) || [ "", "" ])[ 1 ].toLowerCase() ] ) {

				value = value.replace( rxhtmlTag, "<$1></$2>" );

				try {
					for (; i < l; i++ ) {
						// Remove element nodes and prevent memory leaks
						elem = this[i] || {};
						if ( elem.nodeType === 1 ) {
							jQuery.cleanData( getAll( elem, false ) );
							elem.innerHTML = value;
						}
					}

					elem = 0;

				// If using innerHTML throws an exception, use the fallback method
				} catch(e) {}
			}

			if ( elem ) {
				this.empty().append( value );
			}
		}, null, value, arguments.length );
	},

	replaceWith: function() {
		var arg = arguments[ 0 ];

		// Make the changes, replacing each context element with the new content
		this.domManip( arguments, function( elem ) {
			arg = this.parentNode;

			jQuery.cleanData( getAll( this ) );

			if ( arg ) {
				arg.replaceChild( elem, this );
			}
		});

		// Force removal if there was no new content (e.g., from empty arguments)
		return arg && (arg.length || arg.nodeType) ? this : this.remove();
	},

	detach: function( selector ) {
		return this.remove( selector, true );
	},

	domManip: function( args, callback ) {

		// Flatten any nested arrays
		args = concat.apply( [], args );

		var first, node, hasScripts,
			scripts, doc, fragment,
			i = 0,
			l = this.length,
			set = this,
			iNoClone = l - 1,
			value = args[0],
			isFunction = jQuery.isFunction( value );

		// We can't cloneNode fragments that contain checked, in WebKit
		if ( isFunction ||
				( l > 1 && typeof value === "string" &&
					!support.checkClone && rchecked.test( value ) ) ) {
			return this.each(function( index ) {
				var self = set.eq( index );
				if ( isFunction ) {
					args[0] = value.call( this, index, self.html() );
				}
				self.domManip( args, callback );
			});
		}

		if ( l ) {
			fragment = jQuery.buildFragment( args, this[ 0 ].ownerDocument, false, this );
			first = fragment.firstChild;

			if ( fragment.childNodes.length === 1 ) {
				fragment = first;
			}

			if ( first ) {
				scripts = jQuery.map( getAll( fragment, "script" ), disableScript );
				hasScripts = scripts.length;

				// Use the original fragment for the last item instead of the first because it can end up
				// being emptied incorrectly in certain situations (#8070).
				for ( ; i < l; i++ ) {
					node = fragment;

					if ( i !== iNoClone ) {
						node = jQuery.clone( node, true, true );

						// Keep references to cloned scripts for later restoration
						if ( hasScripts ) {
							jQuery.merge( scripts, getAll( node, "script" ) );
						}
					}

					callback.call( this[i], node, i );
				}

				if ( hasScripts ) {
					doc = scripts[ scripts.length - 1 ].ownerDocument;

					// Reenable scripts
					jQuery.map( scripts, restoreScript );

					// Evaluate executable scripts on first document insertion
					for ( i = 0; i < hasScripts; i++ ) {
						node = scripts[ i ];
						if ( rscriptType.test( node.type || "" ) &&
							!jQuery._data( node, "globalEval" ) && jQuery.contains( doc, node ) ) {

							if ( node.src ) {
								// Optional AJAX dependency, but won't run scripts if not present
								if ( jQuery._evalUrl ) {
									jQuery._evalUrl( node.src );
								}
							} else {
								jQuery.globalEval( ( node.text || node.textContent || node.innerHTML || "" ).replace( rcleanScript, "" ) );
							}
						}
					}
				}

				// Fix #11809: Avoid leaking memory
				fragment = first = null;
			}
		}

		return this;
	}
});

jQuery.each({
	appendTo: "append",
	prependTo: "prepend",
	insertBefore: "before",
	insertAfter: "after",
	replaceAll: "replaceWith"
}, function( name, original ) {
	jQuery.fn[ name ] = function( selector ) {
		var elems,
			i = 0,
			ret = [],
			insert = jQuery( selector ),
			last = insert.length - 1;

		for ( ; i <= last; i++ ) {
			elems = i === last ? this : this.clone(true);
			jQuery( insert[i] )[ original ]( elems );

			// Modern browsers can apply jQuery collections as arrays, but oldIE needs a .get()
			push.apply( ret, elems.get() );
		}

		return this.pushStack( ret );
	};
});


var iframe,
	elemdisplay = {};

/**
 * Retrieve the actual display of a element
 * @param {String} name nodeName of the element
 * @param {Object} doc Document object
 */
// Called only from within defaultDisplay
function actualDisplay( name, doc ) {
	var elem = jQuery( doc.createElement( name ) ).appendTo( doc.body ),

		// getDefaultComputedStyle might be reliably used only on attached element
		display = window.getDefaultComputedStyle ?

			// Use of this method is a temporary fix (more like optmization) until something better comes along,
			// since it was removed from specification and supported only in FF
			window.getDefaultComputedStyle( elem[ 0 ] ).display : jQuery.css( elem[ 0 ], "display" );

	// We don't have any data stored on the element,
	// so use "detach" method as fast way to get rid of the element
	elem.detach();

	return display;
}

/**
 * Try to determine the default display value of an element
 * @param {String} nodeName
 */
function defaultDisplay( nodeName ) {
	var doc = document,
		display = elemdisplay[ nodeName ];

	if ( !display ) {
		display = actualDisplay( nodeName, doc );

		// If the simple way fails, read from inside an iframe
		if ( display === "none" || !display ) {

			// Use the already-created iframe if possible
			iframe = (iframe || jQuery( "<iframe frameborder='0' width='0' height='0'/>" )).appendTo( doc.documentElement );

			// Always write a new HTML skeleton so Webkit and Firefox don't choke on reuse
			doc = ( iframe[ 0 ].contentWindow || iframe[ 0 ].contentDocument ).document;

			// Support: IE
			doc.write();
			doc.close();

			display = actualDisplay( nodeName, doc );
			iframe.detach();
		}

		// Store the correct default display
		elemdisplay[ nodeName ] = display;
	}

	return display;
}


(function() {
	var a, shrinkWrapBlocksVal,
		div = document.createElement( "div" ),
		divReset =
			"-webkit-box-sizing:content-box;-moz-box-sizing:content-box;box-sizing:content-box;" +
			"display:block;padding:0;margin:0;border:0";

	// Setup
	div.innerHTML = "  <link/><table></table><a href='/a'>a</a><input type='checkbox'/>";
	a = div.getElementsByTagName( "a" )[ 0 ];

	a.style.cssText = "float:left;opacity:.5";

	// Make sure that element opacity exists
	// (IE uses filter instead)
	// Use a regex to work around a WebKit issue. See #5145
	support.opacity = /^0.5/.test( a.style.opacity );

	// Verify style float existence
	// (IE uses styleFloat instead of cssFloat)
	support.cssFloat = !!a.style.cssFloat;

	div.style.backgroundClip = "content-box";
	div.cloneNode( true ).style.backgroundClip = "";
	support.clearCloneStyle = div.style.backgroundClip === "content-box";

	// Null elements to avoid leaks in IE.
	a = div = null;

	support.shrinkWrapBlocks = function() {
		var body, container, div, containerStyles;

		if ( shrinkWrapBlocksVal == null ) {
			body = document.getElementsByTagName( "body" )[ 0 ];
			if ( !body ) {
				// Test fired too early or in an unsupported environment, exit.
				return;
			}

			containerStyles = "border:0;width:0;height:0;position:absolute;top:0;left:-9999px";
			container = document.createElement( "div" );
			div = document.createElement( "div" );

			body.appendChild( container ).appendChild( div );

			// Will be changed later if needed.
			shrinkWrapBlocksVal = false;

			if ( typeof div.style.zoom !== strundefined ) {
				// Support: IE6
				// Check if elements with layout shrink-wrap their children
				div.style.cssText = divReset + ";width:1px;padding:1px;zoom:1";
				div.innerHTML = "<div></div>";
				div.firstChild.style.width = "5px";
				shrinkWrapBlocksVal = div.offsetWidth !== 3;
			}

			body.removeChild( container );

			// Null elements to avoid leaks in IE.
			body = container = div = null;
		}

		return shrinkWrapBlocksVal;
	};

})();
var rmargin = (/^margin/);

var rnumnonpx = new RegExp( "^(" + pnum + ")(?!px)[a-z%]+$", "i" );



var getStyles, curCSS,
	rposition = /^(top|right|bottom|left)$/;

if ( window.getComputedStyle ) {
	getStyles = function( elem ) {
		return elem.ownerDocument.defaultView.getComputedStyle( elem, null );
	};

	curCSS = function( elem, name, computed ) {
		var width, minWidth, maxWidth, ret,
			style = elem.style;

		computed = computed || getStyles( elem );

		// getPropertyValue is only needed for .css('filter') in IE9, see #12537
		ret = computed ? computed.getPropertyValue( name ) || computed[ name ] : undefined;

		if ( computed ) {

			if ( ret === "" && !jQuery.contains( elem.ownerDocument, elem ) ) {
				ret = jQuery.style( elem, name );
			}

			// A tribute to the "awesome hack by Dean Edwards"
			// Chrome < 17 and Safari 5.0 uses "computed value" instead of "used value" for margin-right
			// Safari 5.1.7 (at least) returns percentage for a larger set of values, but width seems to be reliably pixels
			// this is against the CSSOM draft spec: http://dev.w3.org/csswg/cssom/#resolved-values
			if ( rnumnonpx.test( ret ) && rmargin.test( name ) ) {

				// Remember the original values
				width = style.width;
				minWidth = style.minWidth;
				maxWidth = style.maxWidth;

				// Put in the new values to get a computed value out
				style.minWidth = style.maxWidth = style.width = ret;
				ret = computed.width;

				// Revert the changed values
				style.width = width;
				style.minWidth = minWidth;
				style.maxWidth = maxWidth;
			}
		}

		// Support: IE
		// IE returns zIndex value as an integer.
		return ret === undefined ?
			ret :
			ret + "";
	};
} else if ( document.documentElement.currentStyle ) {
	getStyles = function( elem ) {
		return elem.currentStyle;
	};

	curCSS = function( elem, name, computed ) {
		var left, rs, rsLeft, ret,
			style = elem.style;

		computed = computed || getStyles( elem );
		ret = computed ? computed[ name ] : undefined;

		// Avoid setting ret to empty string here
		// so we don't default to auto
		if ( ret == null && style && style[ name ] ) {
			ret = style[ name ];
		}

		// From the awesome hack by Dean Edwards
		// http://erik.eae.net/archives/2007/07/27/18.54.15/#comment-102291

		// If we're not dealing with a regular pixel number
		// but a number that has a weird ending, we need to convert it to pixels
		// but not position css attributes, as those are proportional to the parent element instead
		// and we can't measure the parent instead because it might trigger a "stacking dolls" problem
		if ( rnumnonpx.test( ret ) && !rposition.test( name ) ) {

			// Remember the original values
			left = style.left;
			rs = elem.runtimeStyle;
			rsLeft = rs && rs.left;

			// Put in the new values to get a computed value out
			if ( rsLeft ) {
				rs.left = elem.currentStyle.left;
			}
			style.left = name === "fontSize" ? "1em" : ret;
			ret = style.pixelLeft + "px";

			// Revert the changed values
			style.left = left;
			if ( rsLeft ) {
				rs.left = rsLeft;
			}
		}

		// Support: IE
		// IE returns zIndex value as an integer.
		return ret === undefined ?
			ret :
			ret + "" || "auto";
	};
}




function addGetHookIf( conditionFn, hookFn ) {
	// Define the hook, we'll check on the first run if it's really needed.
	return {
		get: function() {
			var condition = conditionFn();

			if ( condition == null ) {
				// The test was not ready at this point; screw the hook this time
				// but check again when needed next time.
				return;
			}

			if ( condition ) {
				// Hook not needed (or it's not possible to use it due to missing dependency),
				// remove it.
				// Since there are no other hooks for marginRight, remove the whole object.
				delete this.get;
				return;
			}

			// Hook needed; redefine it so that the support test is not executed again.

			return (this.get = hookFn).apply( this, arguments );
		}
	};
}


(function() {
	var a, reliableHiddenOffsetsVal, boxSizingVal, boxSizingReliableVal,
		pixelPositionVal, reliableMarginRightVal,
		div = document.createElement( "div" ),
		containerStyles = "border:0;width:0;height:0;position:absolute;top:0;left:-9999px",
		divReset =
			"-webkit-box-sizing:content-box;-moz-box-sizing:content-box;box-sizing:content-box;" +
			"display:block;padding:0;margin:0;border:0";

	// Setup
	div.innerHTML = "  <link/><table></table><a href='/a'>a</a><input type='checkbox'/>";
	a = div.getElementsByTagName( "a" )[ 0 ];

	a.style.cssText = "float:left;opacity:.5";

	// Make sure that element opacity exists
	// (IE uses filter instead)
	// Use a regex to work around a WebKit issue. See #5145
	support.opacity = /^0.5/.test( a.style.opacity );

	// Verify style float existence
	// (IE uses styleFloat instead of cssFloat)
	support.cssFloat = !!a.style.cssFloat;

	div.style.backgroundClip = "content-box";
	div.cloneNode( true ).style.backgroundClip = "";
	support.clearCloneStyle = div.style.backgroundClip === "content-box";

	// Null elements to avoid leaks in IE.
	a = div = null;

	jQuery.extend(support, {
		reliableHiddenOffsets: function() {
			if ( reliableHiddenOffsetsVal != null ) {
				return reliableHiddenOffsetsVal;
			}

			var container, tds, isSupported,
				div = document.createElement( "div" ),
				body = document.getElementsByTagName( "body" )[ 0 ];

			if ( !body ) {
				// Return for frameset docs that don't have a body
				return;
			}

			// Setup
			div.setAttribute( "className", "t" );
			div.innerHTML = "  <link/><table></table><a href='/a'>a</a><input type='checkbox'/>";

			container = document.createElement( "div" );
			container.style.cssText = containerStyles;

			body.appendChild( container ).appendChild( div );

			// Support: IE8
			// Check if table cells still have offsetWidth/Height when they are set
			// to display:none and there are still other visible table cells in a
			// table row; if so, offsetWidth/Height are not reliable for use when
			// determining if an element has been hidden directly using
			// display:none (it is still safe to use offsets if a parent element is
			// hidden; don safety goggles and see bug #4512 for more information).
			div.innerHTML = "<table><tr><td></td><td>t</td></tr></table>";
			tds = div.getElementsByTagName( "td" );
			tds[ 0 ].style.cssText = "padding:0;margin:0;border:0;display:none";
			isSupported = ( tds[ 0 ].offsetHeight === 0 );

			tds[ 0 ].style.display = "";
			tds[ 1 ].style.display = "none";

			// Support: IE8
			// Check if empty table cells still have offsetWidth/Height
			reliableHiddenOffsetsVal = isSupported && ( tds[ 0 ].offsetHeight === 0 );

			body.removeChild( container );

			// Null elements to avoid leaks in IE.
			div = body = null;

			return reliableHiddenOffsetsVal;
		},

		boxSizing: function() {
			if ( boxSizingVal == null ) {
				computeStyleTests();
			}
			return boxSizingVal;
		},

		boxSizingReliable: function() {
			if ( boxSizingReliableVal == null ) {
				computeStyleTests();
			}
			return boxSizingReliableVal;
		},

		pixelPosition: function() {
			if ( pixelPositionVal == null ) {
				computeStyleTests();
			}
			return pixelPositionVal;
		},

		reliableMarginRight: function() {
			var body, container, div, marginDiv;

			// Use window.getComputedStyle because jsdom on node.js will break without it.
			if ( reliableMarginRightVal == null && window.getComputedStyle ) {
				body = document.getElementsByTagName( "body" )[ 0 ];
				if ( !body ) {
					// Test fired too early or in an unsupported environment, exit.
					return;
				}

				container = document.createElement( "div" );
				div = document.createElement( "div" );
				container.style.cssText = containerStyles;

				body.appendChild( container ).appendChild( div );

				// Check if div with explicit width and no margin-right incorrectly
				// gets computed margin-right based on width of container. (#3333)
				// Fails in WebKit before Feb 2011 nightlies
				// WebKit Bug 13343 - getComputedStyle returns wrong value for margin-right
				marginDiv = div.appendChild( document.createElement( "div" ) );
				marginDiv.style.cssText = div.style.cssText = divReset;
				marginDiv.style.marginRight = marginDiv.style.width = "0";
				div.style.width = "1px";

				reliableMarginRightVal =
					!parseFloat( ( window.getComputedStyle( marginDiv, null ) || {} ).marginRight );

				body.removeChild( container );
			}

			return reliableMarginRightVal;
		}
	});

	function computeStyleTests() {
		var container, div,
			body = document.getElementsByTagName( "body" )[ 0 ];

		if ( !body ) {
			// Test fired too early or in an unsupported environment, exit.
			return;
		}

		container = document.createElement( "div" );
		div = document.createElement( "div" );
		container.style.cssText = containerStyles;

		body.appendChild( container ).appendChild( div );

		div.style.cssText =
			"-webkit-box-sizing:border-box;-moz-box-sizing:border-box;box-sizing:border-box;" +
				"position:absolute;display:block;padding:1px;border:1px;width:4px;" +
				"margin-top:1%;top:1%";

		// Workaround failing boxSizing test due to offsetWidth returning wrong value
		// with some non-1 values of body zoom, ticket #13543
		jQuery.swap( body, body.style.zoom != null ? { zoom: 1 } : {}, function() {
			boxSizingVal = div.offsetWidth === 4;
		});

		// Will be changed later if needed.
		boxSizingReliableVal = true;
		pixelPositionVal = false;
		reliableMarginRightVal = true;

		// Use window.getComputedStyle because jsdom on node.js will break without it.
		if ( window.getComputedStyle ) {
			pixelPositionVal = ( window.getComputedStyle( div, null ) || {} ).top !== "1%";
			boxSizingReliableVal =
				( window.getComputedStyle( div, null ) || { width: "4px" } ).width === "4px";
		}

		body.removeChild( container );

		// Null elements to avoid leaks in IE.
		div = body = null;
	}

})();


// A method for quickly swapping in/out CSS properties to get correct calculations.
jQuery.swap = function( elem, options, callback, args ) {
	var ret, name,
		old = {};

	// Remember the old values, and insert the new ones
	for ( name in options ) {
		old[ name ] = elem.style[ name ];
		elem.style[ name ] = options[ name ];
	}

	ret = callback.apply( elem, args || [] );

	// Revert the old values
	for ( name in options ) {
		elem.style[ name ] = old[ name ];
	}

	return ret;
};


var
		ralpha = /alpha\([^)]*\)/i,
	ropacity = /opacity\s*=\s*([^)]*)/,

	// swappable if display is none or starts with table except "table", "table-cell", or "table-caption"
	// see here for display values: https://developer.mozilla.org/en-US/docs/CSS/display
	rdisplayswap = /^(none|table(?!-c[ea]).+)/,
	rnumsplit = new RegExp( "^(" + pnum + ")(.*)$", "i" ),
	rrelNum = new RegExp( "^([+-])=(" + pnum + ")", "i" ),

	cssShow = { position: "absolute", visibility: "hidden", display: "block" },
	cssNormalTransform = {
		letterSpacing: 0,
		fontWeight: 400
	},

	cssPrefixes = [ "Webkit", "O", "Moz", "ms" ];


// return a css property mapped to a potentially vendor prefixed property
function vendorPropName( style, name ) {

	// shortcut for names that are not vendor prefixed
	if ( name in style ) {
		return name;
	}

	// check for vendor prefixed names
	var capName = name.charAt(0).toUpperCase() + name.slice(1),
		origName = name,
		i = cssPrefixes.length;

	while ( i-- ) {
		name = cssPrefixes[ i ] + capName;
		if ( name in style ) {
			return name;
		}
	}

	return origName;
}

function showHide( elements, show ) {
	var display, elem, hidden,
		values = [],
		index = 0,
		length = elements.length;

	for ( ; index < length; index++ ) {
		elem = elements[ index ];
		if ( !elem.style ) {
			continue;
		}

		values[ index ] = jQuery._data( elem, "olddisplay" );
		display = elem.style.display;
		if ( show ) {
			// Reset the inline display of this element to learn if it is
			// being hidden by cascaded rules or not
			if ( !values[ index ] && display === "none" ) {
				elem.style.display = "";
			}

			// Set elements which have been overridden with display: none
			// in a stylesheet to whatever the default browser style is
			// for such an element
			if ( elem.style.display === "" && isHidden( elem ) ) {
				values[ index ] = jQuery._data( elem, "olddisplay", defaultDisplay(elem.nodeName) );
			}
		} else {

			if ( !values[ index ] ) {
				hidden = isHidden( elem );

				if ( display && display !== "none" || !hidden ) {
					jQuery._data( elem, "olddisplay", hidden ? display : jQuery.css( elem, "display" ) );
				}
			}
		}
	}

	// Set the display of most of the elements in a second loop
	// to avoid the constant reflow
	for ( index = 0; index < length; index++ ) {
		elem = elements[ index ];
		if ( !elem.style ) {
			continue;
		}
		if ( !show || elem.style.display === "none" || elem.style.display === "" ) {
			elem.style.display = show ? values[ index ] || "" : "none";
		}
	}

	return elements;
}

function setPositiveNumber( elem, value, subtract ) {
	var matches = rnumsplit.exec( value );
	return matches ?
		// Guard against undefined "subtract", e.g., when used as in cssHooks
		Math.max( 0, matches[ 1 ] - ( subtract || 0 ) ) + ( matches[ 2 ] || "px" ) :
		value;
}

function augmentWidthOrHeight( elem, name, extra, isBorderBox, styles ) {
	var i = extra === ( isBorderBox ? "border" : "content" ) ?
		// If we already have the right measurement, avoid augmentation
		4 :
		// Otherwise initialize for horizontal or vertical properties
		name === "width" ? 1 : 0,

		val = 0;

	for ( ; i < 4; i += 2 ) {
		// both box models exclude margin, so add it if we want it
		if ( extra === "margin" ) {
			val += jQuery.css( elem, extra + cssExpand[ i ], true, styles );
		}

		if ( isBorderBox ) {
			// border-box includes padding, so remove it if we want content
			if ( extra === "content" ) {
				val -= jQuery.css( elem, "padding" + cssExpand[ i ], true, styles );
			}

			// at this point, extra isn't border nor margin, so remove border
			if ( extra !== "margin" ) {
				val -= jQuery.css( elem, "border" + cssExpand[ i ] + "Width", true, styles );
			}
		} else {
			// at this point, extra isn't content, so add padding
			val += jQuery.css( elem, "padding" + cssExpand[ i ], true, styles );

			// at this point, extra isn't content nor padding, so add border
			if ( extra !== "padding" ) {
				val += jQuery.css( elem, "border" + cssExpand[ i ] + "Width", true, styles );
			}
		}
	}

	return val;
}

function getWidthOrHeight( elem, name, extra ) {

	// Start with offset property, which is equivalent to the border-box value
	var valueIsBorderBox = true,
		val = name === "width" ? elem.offsetWidth : elem.offsetHeight,
		styles = getStyles( elem ),
		isBorderBox = support.boxSizing() && jQuery.css( elem, "boxSizing", false, styles ) === "border-box";

	// some non-html elements return undefined for offsetWidth, so check for null/undefined
	// svg - https://bugzilla.mozilla.org/show_bug.cgi?id=649285
	// MathML - https://bugzilla.mozilla.org/show_bug.cgi?id=491668
	if ( val <= 0 || val == null ) {
		// Fall back to computed then uncomputed css if necessary
		val = curCSS( elem, name, styles );
		if ( val < 0 || val == null ) {
			val = elem.style[ name ];
		}

		// Computed unit is not pixels. Stop here and return.
		if ( rnumnonpx.test(val) ) {
			return val;
		}

		// we need the check for style in case a browser which returns unreliable values
		// for getComputedStyle silently falls back to the reliable elem.style
		valueIsBorderBox = isBorderBox && ( support.boxSizingReliable() || val === elem.style[ name ] );

		// Normalize "", auto, and prepare for extra
		val = parseFloat( val ) || 0;
	}

	// use the active box-sizing model to add/subtract irrelevant styles
	return ( val +
		augmentWidthOrHeight(
			elem,
			name,
			extra || ( isBorderBox ? "border" : "content" ),
			valueIsBorderBox,
			styles
		)
	) + "px";
}

jQuery.extend({
	// Add in style property hooks for overriding the default
	// behavior of getting and setting a style property
	cssHooks: {
		opacity: {
			get: function( elem, computed ) {
				if ( computed ) {
					// We should always get a number back from opacity
					var ret = curCSS( elem, "opacity" );
					return ret === "" ? "1" : ret;
				}
			}
		}
	},

	// Don't automatically add "px" to these possibly-unitless properties
	cssNumber: {
		"columnCount": true,
		"fillOpacity": true,
		"fontWeight": true,
		"lineHeight": true,
		"opacity": true,
		"order": true,
		"orphans": true,
		"widows": true,
		"zIndex": true,
		"zoom": true
	},

	// Add in properties whose names you wish to fix before
	// setting or getting the value
	cssProps: {
		// normalize float css property
		"float": support.cssFloat ? "cssFloat" : "styleFloat"
	},

	// Get and set the style property on a DOM Node
	style: function( elem, name, value, extra ) {
		// Don't set styles on text and comment nodes
		if ( !elem || elem.nodeType === 3 || elem.nodeType === 8 || !elem.style ) {
			return;
		}

		// Make sure that we're working with the right name
		var ret, type, hooks,
			origName = jQuery.camelCase( name ),
			style = elem.style;

		name = jQuery.cssProps[ origName ] || ( jQuery.cssProps[ origName ] = vendorPropName( style, origName ) );

		// gets hook for the prefixed version
		// followed by the unprefixed version
		hooks = jQuery.cssHooks[ name ] || jQuery.cssHooks[ origName ];

		// Check if we're setting a value
		if ( value !== undefined ) {
			type = typeof value;

			// convert relative number strings (+= or -=) to relative numbers. #7345
			if ( type === "string" && (ret = rrelNum.exec( value )) ) {
				value = ( ret[1] + 1 ) * ret[2] + parseFloat( jQuery.css( elem, name ) );
				// Fixes bug #9237
				type = "number";
			}

			// Make sure that null and NaN values aren't set. See: #7116
			if ( value == null || value !== value ) {
				return;
			}

			// If a number was passed in, add 'px' to the (except for certain CSS properties)
			if ( type === "number" && !jQuery.cssNumber[ origName ] ) {
				value += "px";
			}

			// Fixes #8908, it can be done more correctly by specifing setters in cssHooks,
			// but it would mean to define eight (for every problematic property) identical functions
			if ( !support.clearCloneStyle && value === "" && name.indexOf("background") === 0 ) {
				style[ name ] = "inherit";
			}

			// If a hook was provided, use that value, otherwise just set the specified value
			if ( !hooks || !("set" in hooks) || (value = hooks.set( elem, value, extra )) !== undefined ) {

				// Support: IE
				// Swallow errors from 'invalid' CSS values (#5509)
				try {
					// Support: Chrome, Safari
					// Setting style to blank string required to delete "style: x !important;"
					style[ name ] = "";
					style[ name ] = value;
				} catch(e) {}
			}

		} else {
			// If a hook was provided get the non-computed value from there
			if ( hooks && "get" in hooks && (ret = hooks.get( elem, false, extra )) !== undefined ) {
				return ret;
			}

			// Otherwise just get the value from the style object
			return style[ name ];
		}
	},

	css: function( elem, name, extra, styles ) {
		var num, val, hooks,
			origName = jQuery.camelCase( name );

		// Make sure that we're working with the right name
		name = jQuery.cssProps[ origName ] || ( jQuery.cssProps[ origName ] = vendorPropName( elem.style, origName ) );

		// gets hook for the prefixed version
		// followed by the unprefixed version
		hooks = jQuery.cssHooks[ name ] || jQuery.cssHooks[ origName ];

		// If a hook was provided get the computed value from there
		if ( hooks && "get" in hooks ) {
			val = hooks.get( elem, true, extra );
		}

		// Otherwise, if a way to get the computed value exists, use that
		if ( val === undefined ) {
			val = curCSS( elem, name, styles );
		}

		//convert "normal" to computed value
		if ( val === "normal" && name in cssNormalTransform ) {
			val = cssNormalTransform[ name ];
		}

		// Return, converting to number if forced or a qualifier was provided and val looks numeric
		if ( extra === "" || extra ) {
			num = parseFloat( val );
			return extra === true || jQuery.isNumeric( num ) ? num || 0 : val;
		}
		return val;
	}
});

jQuery.each([ "height", "width" ], function( i, name ) {
	jQuery.cssHooks[ name ] = {
		get: function( elem, computed, extra ) {
			if ( computed ) {
				// certain elements can have dimension info if we invisibly show them
				// however, it must have a current display style that would benefit from this
				return elem.offsetWidth === 0 && rdisplayswap.test( jQuery.css( elem, "display" ) ) ?
					jQuery.swap( elem, cssShow, function() {
						return getWidthOrHeight( elem, name, extra );
					}) :
					getWidthOrHeight( elem, name, extra );
			}
		},

		set: function( elem, value, extra ) {
			var styles = extra && getStyles( elem );
			return setPositiveNumber( elem, value, extra ?
				augmentWidthOrHeight(
					elem,
					name,
					extra,
					support.boxSizing() && jQuery.css( elem, "boxSizing", false, styles ) === "border-box",
					styles
				) : 0
			);
		}
	};
});

if ( !support.opacity ) {
	jQuery.cssHooks.opacity = {
		get: function( elem, computed ) {
			// IE uses filters for opacity
			return ropacity.test( (computed && elem.currentStyle ? elem.currentStyle.filter : elem.style.filter) || "" ) ?
				( 0.01 * parseFloat( RegExp.$1 ) ) + "" :
				computed ? "1" : "";
		},

		set: function( elem, value ) {
			var style = elem.style,
				currentStyle = elem.currentStyle,
				opacity = jQuery.isNumeric( value ) ? "alpha(opacity=" + value * 100 + ")" : "",
				filter = currentStyle && currentStyle.filter || style.filter || "";

			// IE has trouble with opacity if it does not have layout
			// Force it by setting the zoom level
			style.zoom = 1;

			// if setting opacity to 1, and no other filters exist - attempt to remove filter attribute #6652
			// if value === "", then remove inline opacity #12685
			if ( ( value >= 1 || value === "" ) &&
					jQuery.trim( filter.replace( ralpha, "" ) ) === "" &&
					style.removeAttribute ) {

				// Setting style.filter to null, "" & " " still leave "filter:" in the cssText
				// if "filter:" is present at all, clearType is disabled, we want to avoid this
				// style.removeAttribute is IE Only, but so apparently is this code path...
				style.removeAttribute( "filter" );

				// if there is no filter style applied in a css rule or unset inline opacity, we are done
				if ( value === "" || currentStyle && !currentStyle.filter ) {
					return;
				}
			}

			// otherwise, set new filter values
			style.filter = ralpha.test( filter ) ?
				filter.replace( ralpha, opacity ) :
				filter + " " + opacity;
		}
	};
}

jQuery.cssHooks.marginRight = addGetHookIf( support.reliableMarginRight,
	function( elem, computed ) {
		if ( computed ) {
			// WebKit Bug 13343 - getComputedStyle returns wrong value for margin-right
			// Work around by temporarily setting element display to inline-block
			return jQuery.swap( elem, { "display": "inline-block" },
				curCSS, [ elem, "marginRight" ] );
		}
	}
);

// These hooks are used by animate to expand properties
jQuery.each({
	margin: "",
	padding: "",
	border: "Width"
}, function( prefix, suffix ) {
	jQuery.cssHooks[ prefix + suffix ] = {
		expand: function( value ) {
			var i = 0,
				expanded = {},

				// assumes a single number if not a string
				parts = typeof value === "string" ? value.split(" ") : [ value ];

			for ( ; i < 4; i++ ) {
				expanded[ prefix + cssExpand[ i ] + suffix ] =
					parts[ i ] || parts[ i - 2 ] || parts[ 0 ];
			}

			return expanded;
		}
	};

	if ( !rmargin.test( prefix ) ) {
		jQuery.cssHooks[ prefix + suffix ].set = setPositiveNumber;
	}
});

jQuery.fn.extend({
	css: function( name, value ) {
		return access( this, function( elem, name, value ) {
			var styles, len,
				map = {},
				i = 0;

			if ( jQuery.isArray( name ) ) {
				styles = getStyles( elem );
				len = name.length;

				for ( ; i < len; i++ ) {
					map[ name[ i ] ] = jQuery.css( elem, name[ i ], false, styles );
				}

				return map;
			}

			return value !== undefined ?
				jQuery.style( elem, name, value ) :
				jQuery.css( elem, name );
		}, name, value, arguments.length > 1 );
	},
	show: function() {
		return showHide( this, true );
	},
	hide: function() {
		return showHide( this );
	},
	toggle: function( state ) {
		if ( typeof state === "boolean" ) {
			return state ? this.show() : this.hide();
		}

		return this.each(function() {
			if ( isHidden( this ) ) {
				jQuery( this ).show();
			} else {
				jQuery( this ).hide();
			}
		});
	}
});


function Tween( elem, options, prop, end, easing ) {
	return new Tween.prototype.init( elem, options, prop, end, easing );
}
jQuery.Tween = Tween;

Tween.prototype = {
	constructor: Tween,
	init: function( elem, options, prop, end, easing, unit ) {
		this.elem = elem;
		this.prop = prop;
		this.easing = easing || "swing";
		this.options = options;
		this.start = this.now = this.cur();
		this.end = end;
		this.unit = unit || ( jQuery.cssNumber[ prop ] ? "" : "px" );
	},
	cur: function() {
		var hooks = Tween.propHooks[ this.prop ];

		return hooks && hooks.get ?
			hooks.get( this ) :
			Tween.propHooks._default.get( this );
	},
	run: function( percent ) {
		var eased,
			hooks = Tween.propHooks[ this.prop ];

		if ( this.options.duration ) {
			this.pos = eased = jQuery.easing[ this.easing ](
				percent, this.options.duration * percent, 0, 1, this.options.duration
			);
		} else {
			this.pos = eased = percent;
		}
		this.now = ( this.end - this.start ) * eased + this.start;

		if ( this.options.step ) {
			this.options.step.call( this.elem, this.now, this );
		}

		if ( hooks && hooks.set ) {
			hooks.set( this );
		} else {
			Tween.propHooks._default.set( this );
		}
		return this;
	}
};

Tween.prototype.init.prototype = Tween.prototype;

Tween.propHooks = {
	_default: {
		get: function( tween ) {
			var result;

			if ( tween.elem[ tween.prop ] != null &&
				(!tween.elem.style || tween.elem.style[ tween.prop ] == null) ) {
				return tween.elem[ tween.prop ];
			}

			// passing an empty string as a 3rd parameter to .css will automatically
			// attempt a parseFloat and fallback to a string if the parse fails
			// so, simple values such as "10px" are parsed to Float.
			// complex values such as "rotate(1rad)" are returned as is.
			result = jQuery.css( tween.elem, tween.prop, "" );
			// Empty strings, null, undefined and "auto" are converted to 0.
			return !result || result === "auto" ? 0 : result;
		},
		set: function( tween ) {
			// use step hook for back compat - use cssHook if its there - use .style if its
			// available and use plain properties where available
			if ( jQuery.fx.step[ tween.prop ] ) {
				jQuery.fx.step[ tween.prop ]( tween );
			} else if ( tween.elem.style && ( tween.elem.style[ jQuery.cssProps[ tween.prop ] ] != null || jQuery.cssHooks[ tween.prop ] ) ) {
				jQuery.style( tween.elem, tween.prop, tween.now + tween.unit );
			} else {
				tween.elem[ tween.prop ] = tween.now;
			}
		}
	}
};

// Support: IE <=9
// Panic based approach to setting things on disconnected nodes

Tween.propHooks.scrollTop = Tween.propHooks.scrollLeft = {
	set: function( tween ) {
		if ( tween.elem.nodeType && tween.elem.parentNode ) {
			tween.elem[ tween.prop ] = tween.now;
		}
	}
};

jQuery.easing = {
	linear: function( p ) {
		return p;
	},
	swing: function( p ) {
		return 0.5 - Math.cos( p * Math.PI ) / 2;
	}
};

jQuery.fx = Tween.prototype.init;

// Back Compat <1.8 extension point
jQuery.fx.step = {};




var
	fxNow, timerId,
	rfxtypes = /^(?:toggle|show|hide)$/,
	rfxnum = new RegExp( "^(?:([+-])=|)(" + pnum + ")([a-z%]*)$", "i" ),
	rrun = /queueHooks$/,
	animationPrefilters = [ defaultPrefilter ],
	tweeners = {
		"*": [ function( prop, value ) {
			var tween = this.createTween( prop, value ),
				target = tween.cur(),
				parts = rfxnum.exec( value ),
				unit = parts && parts[ 3 ] || ( jQuery.cssNumber[ prop ] ? "" : "px" ),

				// Starting value computation is required for potential unit mismatches
				start = ( jQuery.cssNumber[ prop ] || unit !== "px" && +target ) &&
					rfxnum.exec( jQuery.css( tween.elem, prop ) ),
				scale = 1,
				maxIterations = 20;

			if ( start && start[ 3 ] !== unit ) {
				// Trust units reported by jQuery.css
				unit = unit || start[ 3 ];

				// Make sure we update the tween properties later on
				parts = parts || [];

				// Iteratively approximate from a nonzero starting point
				start = +target || 1;

				do {
					// If previous iteration zeroed out, double until we get *something*
					// Use a string for doubling factor so we don't accidentally see scale as unchanged below
					scale = scale || ".5";

					// Adjust and apply
					start = start / scale;
					jQuery.style( tween.elem, prop, start + unit );

				// Update scale, tolerating zero or NaN from tween.cur()
				// And breaking the loop if scale is unchanged or perfect, or if we've just had enough
				} while ( scale !== (scale = tween.cur() / target) && scale !== 1 && --maxIterations );
			}

			// Update tween properties
			if ( parts ) {
				start = tween.start = +start || +target || 0;
				tween.unit = unit;
				// If a +=/-= token was provided, we're doing a relative animation
				tween.end = parts[ 1 ] ?
					start + ( parts[ 1 ] + 1 ) * parts[ 2 ] :
					+parts[ 2 ];
			}

			return tween;
		} ]
	};

// Animations created synchronously will run synchronously
function createFxNow() {
	setTimeout(function() {
		fxNow = undefined;
	});
	return ( fxNow = jQuery.now() );
}

// Generate parameters to create a standard animation
function genFx( type, includeWidth ) {
	var which,
		attrs = { height: type },
		i = 0;

	// if we include width, step value is 1 to do all cssExpand values,
	// if we don't include width, step value is 2 to skip over Left and Right
	includeWidth = includeWidth ? 1 : 0;
	for ( ; i < 4 ; i += 2 - includeWidth ) {
		which = cssExpand[ i ];
		attrs[ "margin" + which ] = attrs[ "padding" + which ] = type;
	}

	if ( includeWidth ) {
		attrs.opacity = attrs.width = type;
	}

	return attrs;
}

function createTween( value, prop, animation ) {
	var tween,
		collection = ( tweeners[ prop ] || [] ).concat( tweeners[ "*" ] ),
		index = 0,
		length = collection.length;
	for ( ; index < length; index++ ) {
		if ( (tween = collection[ index ].call( animation, prop, value )) ) {

			// we're done with this property
			return tween;
		}
	}
}

function defaultPrefilter( elem, props, opts ) {
	/* jshint validthis: true */
	var prop, value, toggle, tween, hooks, oldfire, display, dDisplay,
		anim = this,
		orig = {},
		style = elem.style,
		hidden = elem.nodeType && isHidden( elem ),
		dataShow = jQuery._data( elem, "fxshow" );

	// handle queue: false promises
	if ( !opts.queue ) {
		hooks = jQuery._queueHooks( elem, "fx" );
		if ( hooks.unqueued == null ) {
			hooks.unqueued = 0;
			oldfire = hooks.empty.fire;
			hooks.empty.fire = function() {
				if ( !hooks.unqueued ) {
					oldfire();
				}
			};
		}
		hooks.unqueued++;

		anim.always(function() {
			// doing this makes sure that the complete handler will be called
			// before this completes
			anim.always(function() {
				hooks.unqueued--;
				if ( !jQuery.queue( elem, "fx" ).length ) {
					hooks.empty.fire();
				}
			});
		});
	}

	// height/width overflow pass
	if ( elem.nodeType === 1 && ( "height" in props || "width" in props ) ) {
		// Make sure that nothing sneaks out
		// Record all 3 overflow attributes because IE does not
		// change the overflow attribute when overflowX and
		// overflowY are set to the same value
		opts.overflow = [ style.overflow, style.overflowX, style.overflowY ];

		// Set display property to inline-block for height/width
		// animations on inline elements that are having width/height animated
		display = jQuery.css( elem, "display" );
		dDisplay = defaultDisplay( elem.nodeName );
		if ( display === "none" ) {
			display = dDisplay;
		}
		if ( display === "inline" &&
				jQuery.css( elem, "float" ) === "none" ) {

			// inline-level elements accept inline-block;
			// block-level elements need to be inline with layout
			if ( !support.inlineBlockNeedsLayout || dDisplay === "inline" ) {
				style.display = "inline-block";
			} else {
				style.zoom = 1;
			}
		}
	}

	if ( opts.overflow ) {
		style.overflow = "hidden";
		if ( !support.shrinkWrapBlocks() ) {
			anim.always(function() {
				style.overflow = opts.overflow[ 0 ];
				style.overflowX = opts.overflow[ 1 ];
				style.overflowY = opts.overflow[ 2 ];
			});
		}
	}

	// show/hide pass
	for ( prop in props ) {
		value = props[ prop ];
		if ( rfxtypes.exec( value ) ) {
			delete props[ prop ];
			toggle = toggle || value === "toggle";
			if ( value === ( hidden ? "hide" : "show" ) ) {

				// If there is dataShow left over from a stopped hide or show and we are going to proceed with show, we should pretend to be hidden
				if ( value === "show" && dataShow && dataShow[ prop ] !== undefined ) {
					hidden = true;
				} else {
					continue;
				}
			}
			orig[ prop ] = dataShow && dataShow[ prop ] || jQuery.style( elem, prop );
		}
	}

	if ( !jQuery.isEmptyObject( orig ) ) {
		if ( dataShow ) {
			if ( "hidden" in dataShow ) {
				hidden = dataShow.hidden;
			}
		} else {
			dataShow = jQuery._data( elem, "fxshow", {} );
		}

		// store state if its toggle - enables .stop().toggle() to "reverse"
		if ( toggle ) {
			dataShow.hidden = !hidden;
		}
		if ( hidden ) {
			jQuery( elem ).show();
		} else {
			anim.done(function() {
				jQuery( elem ).hide();
			});
		}
		anim.done(function() {
			var prop;
			jQuery._removeData( elem, "fxshow" );
			for ( prop in orig ) {
				jQuery.style( elem, prop, orig[ prop ] );
			}
		});
		for ( prop in orig ) {
			tween = createTween( hidden ? dataShow[ prop ] : 0, prop, anim );

			if ( !( prop in dataShow ) ) {
				dataShow[ prop ] = tween.start;
				if ( hidden ) {
					tween.end = tween.start;
					tween.start = prop === "width" || prop === "height" ? 1 : 0;
				}
			}
		}
	}
}

function propFilter( props, specialEasing ) {
	var index, name, easing, value, hooks;

	// camelCase, specialEasing and expand cssHook pass
	for ( index in props ) {
		name = jQuery.camelCase( index );
		easing = specialEasing[ name ];
		value = props[ index ];
		if ( jQuery.isArray( value ) ) {
			easing = value[ 1 ];
			value = props[ index ] = value[ 0 ];
		}

		if ( index !== name ) {
			props[ name ] = value;
			delete props[ index ];
		}

		hooks = jQuery.cssHooks[ name ];
		if ( hooks && "expand" in hooks ) {
			value = hooks.expand( value );
			delete props[ name ];

			// not quite $.extend, this wont overwrite keys already present.
			// also - reusing 'index' from above because we have the correct "name"
			for ( index in value ) {
				if ( !( index in props ) ) {
					props[ index ] = value[ index ];
					specialEasing[ index ] = easing;
				}
			}
		} else {
			specialEasing[ name ] = easing;
		}
	}
}

function Animation( elem, properties, options ) {
	var result,
		stopped,
		index = 0,
		length = animationPrefilters.length,
		deferred = jQuery.Deferred().always( function() {
			// don't match elem in the :animated selector
			delete tick.elem;
		}),
		tick = function() {
			if ( stopped ) {
				return false;
			}
			var currentTime = fxNow || createFxNow(),
				remaining = Math.max( 0, animation.startTime + animation.duration - currentTime ),
				// archaic crash bug won't allow us to use 1 - ( 0.5 || 0 ) (#12497)
				temp = remaining / animation.duration || 0,
				percent = 1 - temp,
				index = 0,
				length = animation.tweens.length;

			for ( ; index < length ; index++ ) {
				animation.tweens[ index ].run( percent );
			}

			deferred.notifyWith( elem, [ animation, percent, remaining ]);

			if ( percent < 1 && length ) {
				return remaining;
			} else {
				deferred.resolveWith( elem, [ animation ] );
				return false;
			}
		},
		animation = deferred.promise({
			elem: elem,
			props: jQuery.extend( {}, properties ),
			opts: jQuery.extend( true, { specialEasing: {} }, options ),
			originalProperties: properties,
			originalOptions: options,
			startTime: fxNow || createFxNow(),
			duration: options.duration,
			tweens: [],
			createTween: function( prop, end ) {
				var tween = jQuery.Tween( elem, animation.opts, prop, end,
						animation.opts.specialEasing[ prop ] || animation.opts.easing );
				animation.tweens.push( tween );
				return tween;
			},
			stop: function( gotoEnd ) {
				var index = 0,
					// if we are going to the end, we want to run all the tweens
					// otherwise we skip this part
					length = gotoEnd ? animation.tweens.length : 0;
				if ( stopped ) {
					return this;
				}
				stopped = true;
				for ( ; index < length ; index++ ) {
					animation.tweens[ index ].run( 1 );
				}

				// resolve when we played the last frame
				// otherwise, reject
				if ( gotoEnd ) {
					deferred.resolveWith( elem, [ animation, gotoEnd ] );
				} else {
					deferred.rejectWith( elem, [ animation, gotoEnd ] );
				}
				return this;
			}
		}),
		props = animation.props;

	propFilter( props, animation.opts.specialEasing );

	for ( ; index < length ; index++ ) {
		result = animationPrefilters[ index ].call( animation, elem, props, animation.opts );
		if ( result ) {
			return result;
		}
	}

	jQuery.map( props, createTween, animation );

	if ( jQuery.isFunction( animation.opts.start ) ) {
		animation.opts.start.call( elem, animation );
	}

	jQuery.fx.timer(
		jQuery.extend( tick, {
			elem: elem,
			anim: animation,
			queue: animation.opts.queue
		})
	);

	// attach callbacks from options
	return animation.progress( animation.opts.progress )
		.done( animation.opts.done, animation.opts.complete )
		.fail( animation.opts.fail )
		.always( animation.opts.always );
}

jQuery.Animation = jQuery.extend( Animation, {
	tweener: function( props, callback ) {
		if ( jQuery.isFunction( props ) ) {
			callback = props;
			props = [ "*" ];
		} else {
			props = props.split(" ");
		}

		var prop,
			index = 0,
			length = props.length;

		for ( ; index < length ; index++ ) {
			prop = props[ index ];
			tweeners[ prop ] = tweeners[ prop ] || [];
			tweeners[ prop ].unshift( callback );
		}
	},

	prefilter: function( callback, prepend ) {
		if ( prepend ) {
			animationPrefilters.unshift( callback );
		} else {
			animationPrefilters.push( callback );
		}
	}
});

jQuery.speed = function( speed, easing, fn ) {
	var opt = speed && typeof speed === "object" ? jQuery.extend( {}, speed ) : {
		complete: fn || !fn && easing ||
			jQuery.isFunction( speed ) && speed,
		duration: speed,
		easing: fn && easing || easing && !jQuery.isFunction( easing ) && easing
	};

	opt.duration = jQuery.fx.off ? 0 : typeof opt.duration === "number" ? opt.duration :
		opt.duration in jQuery.fx.speeds ? jQuery.fx.speeds[ opt.duration ] : jQuery.fx.speeds._default;

	// normalize opt.queue - true/undefined/null -> "fx"
	if ( opt.queue == null || opt.queue === true ) {
		opt.queue = "fx";
	}

	// Queueing
	opt.old = opt.complete;

	opt.complete = function() {
		if ( jQuery.isFunction( opt.old ) ) {
			opt.old.call( this );
		}

		if ( opt.queue ) {
			jQuery.dequeue( this, opt.queue );
		}
	};

	return opt;
};

jQuery.fn.extend({
	fadeTo: function( speed, to, easing, callback ) {

		// show any hidden elements after setting opacity to 0
		return this.filter( isHidden ).css( "opacity", 0 ).show()

			// animate to the value specified
			.end().animate({ opacity: to }, speed, easing, callback );
	},
	animate: function( prop, speed, easing, callback ) {
		var empty = jQuery.isEmptyObject( prop ),
			optall = jQuery.speed( speed, easing, callback ),
			doAnimation = function() {
				// Operate on a copy of prop so per-property easing won't be lost
				var anim = Animation( this, jQuery.extend( {}, prop ), optall );

				// Empty animations, or finishing resolves immediately
				if ( empty || jQuery._data( this, "finish" ) ) {
					anim.stop( true );
				}
			};
			doAnimation.finish = doAnimation;

		return empty || optall.queue === false ?
			this.each( doAnimation ) :
			this.queue( optall.queue, doAnimation );
	},
	stop: function( type, clearQueue, gotoEnd ) {
		var stopQueue = function( hooks ) {
			var stop = hooks.stop;
			delete hooks.stop;
			stop( gotoEnd );
		};

		if ( typeof type !== "string" ) {
			gotoEnd = clearQueue;
			clearQueue = type;
			type = undefined;
		}
		if ( clearQueue && type !== false ) {
			this.queue( type || "fx", [] );
		}

		return this.each(function() {
			var dequeue = true,
				index = type != null && type + "queueHooks",
				timers = jQuery.timers,
				data = jQuery._data( this );

			if ( index ) {
				if ( data[ index ] && data[ index ].stop ) {
					stopQueue( data[ index ] );
				}
			} else {
				for ( index in data ) {
					if ( data[ index ] && data[ index ].stop && rrun.test( index ) ) {
						stopQueue( data[ index ] );
					}
				}
			}

			for ( index = timers.length; index--; ) {
				if ( timers[ index ].elem === this && (type == null || timers[ index ].queue === type) ) {
					timers[ index ].anim.stop( gotoEnd );
					dequeue = false;
					timers.splice( index, 1 );
				}
			}

			// start the next in the queue if the last step wasn't forced
			// timers currently will call their complete callbacks, which will dequeue
			// but only if they were gotoEnd
			if ( dequeue || !gotoEnd ) {
				jQuery.dequeue( this, type );
			}
		});
	},
	finish: function( type ) {
		if ( type !== false ) {
			type = type || "fx";
		}
		return this.each(function() {
			var index,
				data = jQuery._data( this ),
				queue = data[ type + "queue" ],
				hooks = data[ type + "queueHooks" ],
				timers = jQuery.timers,
				length = queue ? queue.length : 0;

			// enable finishing flag on private data
			data.finish = true;

			// empty the queue first
			jQuery.queue( this, type, [] );

			if ( hooks && hooks.stop ) {
				hooks.stop.call( this, true );
			}

			// look for any active animations, and finish them
			for ( index = timers.length; index--; ) {
				if ( timers[ index ].elem === this && timers[ index ].queue === type ) {
					timers[ index ].anim.stop( true );
					timers.splice( index, 1 );
				}
			}

			// look for any animations in the old queue and finish them
			for ( index = 0; index < length; index++ ) {
				if ( queue[ index ] && queue[ index ].finish ) {
					queue[ index ].finish.call( this );
				}
			}

			// turn off finishing flag
			delete data.finish;
		});
	}
});

jQuery.each([ "toggle", "show", "hide" ], function( i, name ) {
	var cssFn = jQuery.fn[ name ];
	jQuery.fn[ name ] = function( speed, easing, callback ) {
		return speed == null || typeof speed === "boolean" ?
			cssFn.apply( this, arguments ) :
			this.animate( genFx( name, true ), speed, easing, callback );
	};
});

// Generate shortcuts for custom animations
jQuery.each({
	slideDown: genFx("show"),
	slideUp: genFx("hide"),
	slideToggle: genFx("toggle"),
	fadeIn: { opacity: "show" },
	fadeOut: { opacity: "hide" },
	fadeToggle: { opacity: "toggle" }
}, function( name, props ) {
	jQuery.fn[ name ] = function( speed, easing, callback ) {
		return this.animate( props, speed, easing, callback );
	};
});

jQuery.timers = [];
jQuery.fx.tick = function() {
	var timer,
		timers = jQuery.timers,
		i = 0;

	fxNow = jQuery.now();

	for ( ; i < timers.length; i++ ) {
		timer = timers[ i ];
		// Checks the timer has not already been removed
		if ( !timer() && timers[ i ] === timer ) {
			timers.splice( i--, 1 );
		}
	}

	if ( !timers.length ) {
		jQuery.fx.stop();
	}
	fxNow = undefined;
};

jQuery.fx.timer = function( timer ) {
	jQuery.timers.push( timer );
	if ( timer() ) {
		jQuery.fx.start();
	} else {
		jQuery.timers.pop();
	}
};

jQuery.fx.interval = 13;

jQuery.fx.start = function() {
	if ( !timerId ) {
		timerId = setInterval( jQuery.fx.tick, jQuery.fx.interval );
	}
};

jQuery.fx.stop = function() {
	clearInterval( timerId );
	timerId = null;
};

jQuery.fx.speeds = {
	slow: 600,
	fast: 200,
	// Default speed
	_default: 400
};


// Based off of the plugin by Clint Helfers, with permission.
// http://blindsignals.com/index.php/2009/07/jquery-delay/
jQuery.fn.delay = function( time, type ) {
	time = jQuery.fx ? jQuery.fx.speeds[ time ] || time : time;
	type = type || "fx";

	return this.queue( type, function( next, hooks ) {
		var timeout = setTimeout( next, time );
		hooks.stop = function() {
			clearTimeout( timeout );
		};
	});
};


(function() {
	var a, input, select, opt,
		div = document.createElement("div" );

	// Setup
	div.setAttribute( "className", "t" );
	div.innerHTML = "  <link/><table></table><a href='/a'>a</a><input type='checkbox'/>";
	a = div.getElementsByTagName("a")[ 0 ];

	// First batch of tests.
	select = document.createElement("select");
	opt = select.appendChild( document.createElement("option") );
	input = div.getElementsByTagName("input")[ 0 ];

	a.style.cssText = "top:1px";

	// Test setAttribute on camelCase class. If it works, we need attrFixes when doing get/setAttribute (ie6/7)
	support.getSetAttribute = div.className !== "t";

	// Get the style information from getAttribute
	// (IE uses .cssText instead)
	support.style = /top/.test( a.getAttribute("style") );

	// Make sure that URLs aren't manipulated
	// (IE normalizes it by default)
	support.hrefNormalized = a.getAttribute("href") === "/a";

	// Check the default checkbox/radio value ("" on WebKit; "on" elsewhere)
	support.checkOn = !!input.value;

	// Make sure that a selected-by-default option has a working selected property.
	// (WebKit defaults to false instead of true, IE too, if it's in an optgroup)
	support.optSelected = opt.selected;

	// Tests for enctype support on a form (#6743)
	support.enctype = !!document.createElement("form").enctype;

	// Make sure that the options inside disabled selects aren't marked as disabled
	// (WebKit marks them as disabled)
	select.disabled = true;
	support.optDisabled = !opt.disabled;

	// Support: IE8 only
	// Check if we can trust getAttribute("value")
	input = document.createElement( "input" );
	input.setAttribute( "value", "" );
	support.input = input.getAttribute( "value" ) === "";

	// Check if an input maintains its value after becoming a radio
	input.value = "t";
	input.setAttribute( "type", "radio" );
	support.radioValue = input.value === "t";

	// Null elements to avoid leaks in IE.
	a = input = select = opt = div = null;
})();


var rreturn = /\r/g;

jQuery.fn.extend({
	val: function( value ) {
		var hooks, ret, isFunction,
			elem = this[0];

		if ( !arguments.length ) {
			if ( elem ) {
				hooks = jQuery.valHooks[ elem.type ] || jQuery.valHooks[ elem.nodeName.toLowerCase() ];

				if ( hooks && "get" in hooks && (ret = hooks.get( elem, "value" )) !== undefined ) {
					return ret;
				}

				ret = elem.value;

				return typeof ret === "string" ?
					// handle most common string cases
					ret.replace(rreturn, "") :
					// handle cases where value is null/undef or number
					ret == null ? "" : ret;
			}

			return;
		}

		isFunction = jQuery.isFunction( value );

		return this.each(function( i ) {
			var val;

			if ( this.nodeType !== 1 ) {
				return;
			}

			if ( isFunction ) {
				val = value.call( this, i, jQuery( this ).val() );
			} else {
				val = value;
			}

			// Treat null/undefined as ""; convert numbers to string
			if ( val == null ) {
				val = "";
			} else if ( typeof val === "number" ) {
				val += "";
			} else if ( jQuery.isArray( val ) ) {
				val = jQuery.map( val, function( value ) {
					return value == null ? "" : value + "";
				});
			}

			hooks = jQuery.valHooks[ this.type ] || jQuery.valHooks[ this.nodeName.toLowerCase() ];

			// If set returns undefined, fall back to normal setting
			if ( !hooks || !("set" in hooks) || hooks.set( this, val, "value" ) === undefined ) {
				this.value = val;
			}
		});
	}
});

jQuery.extend({
	valHooks: {
		option: {
			get: function( elem ) {
				var val = jQuery.find.attr( elem, "value" );
				return val != null ?
					val :
					jQuery.text( elem );
			}
		},
		select: {
			get: function( elem ) {
				var value, option,
					options = elem.options,
					index = elem.selectedIndex,
					one = elem.type === "select-one" || index < 0,
					values = one ? null : [],
					max = one ? index + 1 : options.length,
					i = index < 0 ?
						max :
						one ? index : 0;

				// Loop through all the selected options
				for ( ; i < max; i++ ) {
					option = options[ i ];

					// oldIE doesn't update selected after form reset (#2551)
					if ( ( option.selected || i === index ) &&
							// Don't return options that are disabled or in a disabled optgroup
							( support.optDisabled ? !option.disabled : option.getAttribute("disabled") === null ) &&
							( !option.parentNode.disabled || !jQuery.nodeName( option.parentNode, "optgroup" ) ) ) {

						// Get the specific value for the option
						value = jQuery( option ).val();

						// We don't need an array for one selects
						if ( one ) {
							return value;
						}

						// Multi-Selects return an array
						values.push( value );
					}
				}

				return values;
			},

			set: function( elem, value ) {
				var optionSet, option,
					options = elem.options,
					values = jQuery.makeArray( value ),
					i = options.length;

				while ( i-- ) {
					option = options[ i ];

					if ( jQuery.inArray( jQuery.valHooks.option.get( option ), values ) >= 0 ) {

						// Support: IE6
						// When new option element is added to select box we need to
						// force reflow of newly added node in order to workaround delay
						// of initialization properties
						try {
							option.selected = optionSet = true;

						} catch ( _ ) {

							// Will be executed only in IE6
							option.scrollHeight;
						}

					} else {
						option.selected = false;
					}
				}

				// Force browsers to behave consistently when non-matching value is set
				if ( !optionSet ) {
					elem.selectedIndex = -1;
				}

				return options;
			}
		}
	}
});

// Radios and checkboxes getter/setter
jQuery.each([ "radio", "checkbox" ], function() {
	jQuery.valHooks[ this ] = {
		set: function( elem, value ) {
			if ( jQuery.isArray( value ) ) {
				return ( elem.checked = jQuery.inArray( jQuery(elem).val(), value ) >= 0 );
			}
		}
	};
	if ( !support.checkOn ) {
		jQuery.valHooks[ this ].get = function( elem ) {
			// Support: Webkit
			// "" is returned instead of "on" if a value isn't specified
			return elem.getAttribute("value") === null ? "on" : elem.value;
		};
	}
});




var nodeHook, boolHook,
	attrHandle = jQuery.expr.attrHandle,
	ruseDefault = /^(?:checked|selected)$/i,
	getSetAttribute = support.getSetAttribute,
	getSetInput = support.input;

jQuery.fn.extend({
	attr: function( name, value ) {
		return access( this, jQuery.attr, name, value, arguments.length > 1 );
	},

	removeAttr: function( name ) {
		return this.each(function() {
			jQuery.removeAttr( this, name );
		});
	}
});

jQuery.extend({
	attr: function( elem, name, value ) {
		var hooks, ret,
			nType = elem.nodeType;

		// don't get/set attributes on text, comment and attribute nodes
		if ( !elem || nType === 3 || nType === 8 || nType === 2 ) {
			return;
		}

		// Fallback to prop when attributes are not supported
		if ( typeof elem.getAttribute === strundefined ) {
			return jQuery.prop( elem, name, value );
		}

		// All attributes are lowercase
		// Grab necessary hook if one is defined
		if ( nType !== 1 || !jQuery.isXMLDoc( elem ) ) {
			name = name.toLowerCase();
			hooks = jQuery.attrHooks[ name ] ||
				( jQuery.expr.match.bool.test( name ) ? boolHook : nodeHook );
		}

		if ( value !== undefined ) {

			if ( value === null ) {
				jQuery.removeAttr( elem, name );

			} else if ( hooks && "set" in hooks && (ret = hooks.set( elem, value, name )) !== undefined ) {
				return ret;

			} else {
				elem.setAttribute( name, value + "" );
				return value;
			}

		} else if ( hooks && "get" in hooks && (ret = hooks.get( elem, name )) !== null ) {
			return ret;

		} else {
			ret = jQuery.find.attr( elem, name );

			// Non-existent attributes return null, we normalize to undefined
			return ret == null ?
				undefined :
				ret;
		}
	},

	removeAttr: function( elem, value ) {
		var name, propName,
			i = 0,
			attrNames = value && value.match( rnotwhite );

		if ( attrNames && elem.nodeType === 1 ) {
			while ( (name = attrNames[i++]) ) {
				propName = jQuery.propFix[ name ] || name;

				// Boolean attributes get special treatment (#10870)
				if ( jQuery.expr.match.bool.test( name ) ) {
					// Set corresponding property to false
					if ( getSetInput && getSetAttribute || !ruseDefault.test( name ) ) {
						elem[ propName ] = false;
					// Support: IE<9
					// Also clear defaultChecked/defaultSelected (if appropriate)
					} else {
						elem[ jQuery.camelCase( "default-" + name ) ] =
							elem[ propName ] = false;
					}

				// See #9699 for explanation of this approach (setting first, then removal)
				} else {
					jQuery.attr( elem, name, "" );
				}

				elem.removeAttribute( getSetAttribute ? name : propName );
			}
		}
	},

	attrHooks: {
		type: {
			set: function( elem, value ) {
				if ( !support.radioValue && value === "radio" && jQuery.nodeName(elem, "input") ) {
					// Setting the type on a radio button after the value resets the value in IE6-9
					// Reset value to default in case type is set after value during creation
					var val = elem.value;
					elem.setAttribute( "type", value );
					if ( val ) {
						elem.value = val;
					}
					return value;
				}
			}
		}
	}
});

// Hook for boolean attributes
boolHook = {
	set: function( elem, value, name ) {
		if ( value === false ) {
			// Remove boolean attributes when set to false
			jQuery.removeAttr( elem, name );
		} else if ( getSetInput && getSetAttribute || !ruseDefault.test( name ) ) {
			// IE<8 needs the *property* name
			elem.setAttribute( !getSetAttribute && jQuery.propFix[ name ] || name, name );

		// Use defaultChecked and defaultSelected for oldIE
		} else {
			elem[ jQuery.camelCase( "default-" + name ) ] = elem[ name ] = true;
		}

		return name;
	}
};

// Retrieve booleans specially
jQuery.each( jQuery.expr.match.bool.source.match( /\w+/g ), function( i, name ) {

	var getter = attrHandle[ name ] || jQuery.find.attr;

	attrHandle[ name ] = getSetInput && getSetAttribute || !ruseDefault.test( name ) ?
		function( elem, name, isXML ) {
			var ret, handle;
			if ( !isXML ) {
				// Avoid an infinite loop by temporarily removing this function from the getter
				handle = attrHandle[ name ];
				attrHandle[ name ] = ret;
				ret = getter( elem, name, isXML ) != null ?
					name.toLowerCase() :
					null;
				attrHandle[ name ] = handle;
			}
			return ret;
		} :
		function( elem, name, isXML ) {
			if ( !isXML ) {
				return elem[ jQuery.camelCase( "default-" + name ) ] ?
					name.toLowerCase() :
					null;
			}
		};
});

// fix oldIE attroperties
if ( !getSetInput || !getSetAttribute ) {
	jQuery.attrHooks.value = {
		set: function( elem, value, name ) {
			if ( jQuery.nodeName( elem, "input" ) ) {
				// Does not return so that setAttribute is also used
				elem.defaultValue = value;
			} else {
				// Use nodeHook if defined (#1954); otherwise setAttribute is fine
				return nodeHook && nodeHook.set( elem, value, name );
			}
		}
	};
}

// IE6/7 do not support getting/setting some attributes with get/setAttribute
if ( !getSetAttribute ) {

	// Use this for any attribute in IE6/7
	// This fixes almost every IE6/7 issue
	nodeHook = {
		set: function( elem, value, name ) {
			// Set the existing or create a new attribute node
			var ret = elem.getAttributeNode( name );
			if ( !ret ) {
				elem.setAttributeNode(
					(ret = elem.ownerDocument.createAttribute( name ))
				);
			}

			ret.value = value += "";

			// Break association with cloned elements by also using setAttribute (#9646)
			if ( name === "value" || value === elem.getAttribute( name ) ) {
				return value;
			}
		}
	};

	// Some attributes are constructed with empty-string values when not defined
	attrHandle.id = attrHandle.name = attrHandle.coords =
		function( elem, name, isXML ) {
			var ret;
			if ( !isXML ) {
				return (ret = elem.getAttributeNode( name )) && ret.value !== "" ?
					ret.value :
					null;
			}
		};

	// Fixing value retrieval on a button requires this module
	jQuery.valHooks.button = {
		get: function( elem, name ) {
			var ret = elem.getAttributeNode( name );
			if ( ret && ret.specified ) {
				return ret.value;
			}
		},
		set: nodeHook.set
	};

	// Set contenteditable to false on removals(#10429)
	// Setting to empty string throws an error as an invalid value
	jQuery.attrHooks.contenteditable = {
		set: function( elem, value, name ) {
			nodeHook.set( elem, value === "" ? false : value, name );
		}
	};

	// Set width and height to auto instead of 0 on empty string( Bug #8150 )
	// This is for removals
	jQuery.each([ "width", "height" ], function( i, name ) {
		jQuery.attrHooks[ name ] = {
			set: function( elem, value ) {
				if ( value === "" ) {
					elem.setAttribute( name, "auto" );
					return value;
				}
			}
		};
	});
}

if ( !support.style ) {
	jQuery.attrHooks.style = {
		get: function( elem ) {
			// Return undefined in the case of empty string
			// Note: IE uppercases css property names, but if we were to .toLowerCase()
			// .cssText, that would destroy case senstitivity in URL's, like in "background"
			return elem.style.cssText || undefined;
		},
		set: function( elem, value ) {
			return ( elem.style.cssText = value + "" );
		}
	};
}




var rfocusable = /^(?:input|select|textarea|button|object)$/i,
	rclickable = /^(?:a|area)$/i;

jQuery.fn.extend({
	prop: function( name, value ) {
		return access( this, jQuery.prop, name, value, arguments.length > 1 );
	},

	removeProp: function( name ) {
		name = jQuery.propFix[ name ] || name;
		return this.each(function() {
			// try/catch handles cases where IE balks (such as removing a property on window)
			try {
				this[ name ] = undefined;
				delete this[ name ];
			} catch( e ) {}
		});
	}
});

jQuery.extend({
	propFix: {
		"for": "htmlFor",
		"class": "className"
	},

	prop: function( elem, name, value ) {
		var ret, hooks, notxml,
			nType = elem.nodeType;

		// don't get/set properties on text, comment and attribute nodes
		if ( !elem || nType === 3 || nType === 8 || nType === 2 ) {
			return;
		}

		notxml = nType !== 1 || !jQuery.isXMLDoc( elem );

		if ( notxml ) {
			// Fix name and attach hooks
			name = jQuery.propFix[ name ] || name;
			hooks = jQuery.propHooks[ name ];
		}

		if ( value !== undefined ) {
			return hooks && "set" in hooks && (ret = hooks.set( elem, value, name )) !== undefined ?
				ret :
				( elem[ name ] = value );

		} else {
			return hooks && "get" in hooks && (ret = hooks.get( elem, name )) !== null ?
				ret :
				elem[ name ];
		}
	},

	propHooks: {
		tabIndex: {
			get: function( elem ) {
				// elem.tabIndex doesn't always return the correct value when it hasn't been explicitly set
				// http://fluidproject.org/blog/2008/01/09/getting-setting-and-removing-tabindex-values-with-javascript/
				// Use proper attribute retrieval(#12072)
				var tabindex = jQuery.find.attr( elem, "tabindex" );

				return tabindex ?
					parseInt( tabindex, 10 ) :
					rfocusable.test( elem.nodeName ) || rclickable.test( elem.nodeName ) && elem.href ?
						0 :
						-1;
			}
		}
	}
});

// Some attributes require a special call on IE
// http://msdn.microsoft.com/en-us/library/ms536429%28VS.85%29.aspx
if ( !support.hrefNormalized ) {
	// href/src property should get the full normalized URL (#10299/#12915)
	jQuery.each([ "href", "src" ], function( i, name ) {
		jQuery.propHooks[ name ] = {
			get: function( elem ) {
				return elem.getAttribute( name, 4 );
			}
		};
	});
}

// Support: Safari, IE9+
// mis-reports the default selected property of an option
// Accessing the parent's selectedIndex property fixes it
if ( !support.optSelected ) {
	jQuery.propHooks.selected = {
		get: function( elem ) {
			var parent = elem.parentNode;

			if ( parent ) {
				parent.selectedIndex;

				// Make sure that it also works with optgroups, see #5701
				if ( parent.parentNode ) {
					parent.parentNode.selectedIndex;
				}
			}
			return null;
		}
	};
}

jQuery.each([
	"tabIndex",
	"readOnly",
	"maxLength",
	"cellSpacing",
	"cellPadding",
	"rowSpan",
	"colSpan",
	"useMap",
	"frameBorder",
	"contentEditable"
], function() {
	jQuery.propFix[ this.toLowerCase() ] = this;
});

// IE6/7 call enctype encoding
if ( !support.enctype ) {
	jQuery.propFix.enctype = "encoding";
}




var rclass = /[\t\r\n\f]/g;

jQuery.fn.extend({
	addClass: function( value ) {
		var classes, elem, cur, clazz, j, finalValue,
			i = 0,
			len = this.length,
			proceed = typeof value === "string" && value;

		if ( jQuery.isFunction( value ) ) {
			return this.each(function( j ) {
				jQuery( this ).addClass( value.call( this, j, this.className ) );
			});
		}

		if ( proceed ) {
			// The disjunction here is for better compressibility (see removeClass)
			classes = ( value || "" ).match( rnotwhite ) || [];

			for ( ; i < len; i++ ) {
				elem = this[ i ];
				cur = elem.nodeType === 1 && ( elem.className ?
					( " " + elem.className + " " ).replace( rclass, " " ) :
					" "
				);

				if ( cur ) {
					j = 0;
					while ( (clazz = classes[j++]) ) {
						if ( cur.indexOf( " " + clazz + " " ) < 0 ) {
							cur += clazz + " ";
						}
					}

					// only assign if different to avoid unneeded rendering.
					finalValue = jQuery.trim( cur );
					if ( elem.className !== finalValue ) {
						elem.className = finalValue;
					}
				}
			}
		}

		return this;
	},

	removeClass: function( value ) {
		var classes, elem, cur, clazz, j, finalValue,
			i = 0,
			len = this.length,
			proceed = arguments.length === 0 || typeof value === "string" && value;

		if ( jQuery.isFunction( value ) ) {
			return this.each(function( j ) {
				jQuery( this ).removeClass( value.call( this, j, this.className ) );
			});
		}
		if ( proceed ) {
			classes = ( value || "" ).match( rnotwhite ) || [];

			for ( ; i < len; i++ ) {
				elem = this[ i ];
				// This expression is here for better compressibility (see addClass)
				cur = elem.nodeType === 1 && ( elem.className ?
					( " " + elem.className + " " ).replace( rclass, " " ) :
					""
				);

				if ( cur ) {
					j = 0;
					while ( (clazz = classes[j++]) ) {
						// Remove *all* instances
						while ( cur.indexOf( " " + clazz + " " ) >= 0 ) {
							cur = cur.replace( " " + clazz + " ", " " );
						}
					}

					// only assign if different to avoid unneeded rendering.
					finalValue = value ? jQuery.trim( cur ) : "";
					if ( elem.className !== finalValue ) {
						elem.className = finalValue;
					}
				}
			}
		}

		return this;
	},

	toggleClass: function( value, stateVal ) {
		var type = typeof value;

		if ( typeof stateVal === "boolean" && type === "string" ) {
			return stateVal ? this.addClass( value ) : this.removeClass( value );
		}

		if ( jQuery.isFunction( value ) ) {
			return this.each(function( i ) {
				jQuery( this ).toggleClass( value.call(this, i, this.className, stateVal), stateVal );
			});
		}

		return this.each(function() {
			if ( type === "string" ) {
				// toggle individual class names
				var className,
					i = 0,
					self = jQuery( this ),
					classNames = value.match( rnotwhite ) || [];

				while ( (className = classNames[ i++ ]) ) {
					// check each className given, space separated list
					if ( self.hasClass( className ) ) {
						self.removeClass( className );
					} else {
						self.addClass( className );
					}
				}

			// Toggle whole class name
			} else if ( type === strundefined || type === "boolean" ) {
				if ( this.className ) {
					// store className if set
					jQuery._data( this, "__className__", this.className );
				}

				// If the element has a class name or if we're passed "false",
				// then remove the whole classname (if there was one, the above saved it).
				// Otherwise bring back whatever was previously saved (if anything),
				// falling back to the empty string if nothing was stored.
				this.className = this.className || value === false ? "" : jQuery._data( this, "__className__" ) || "";
			}
		});
	},

	hasClass: function( selector ) {
		var className = " " + selector + " ",
			i = 0,
			l = this.length;
		for ( ; i < l; i++ ) {
			if ( this[i].nodeType === 1 && (" " + this[i].className + " ").replace(rclass, " ").indexOf( className ) >= 0 ) {
				return true;
			}
		}

		return false;
	}
});




// Return jQuery for attributes-only inclusion


jQuery.each( ("blur focus focusin focusout load resize scroll unload click dblclick " +
	"mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave " +
	"change select submit keydown keypress keyup error contextmenu").split(" "), function( i, name ) {

	// Handle event binding
	jQuery.fn[ name ] = function( data, fn ) {
		return arguments.length > 0 ?
			this.on( name, null, data, fn ) :
			this.trigger( name );
	};
});

jQuery.fn.extend({
	hover: function( fnOver, fnOut ) {
		return this.mouseenter( fnOver ).mouseleave( fnOut || fnOver );
	},

	bind: function( types, data, fn ) {
		return this.on( types, null, data, fn );
	},
	unbind: function( types, fn ) {
		return this.off( types, null, fn );
	},

	delegate: function( selector, types, data, fn ) {
		return this.on( types, selector, data, fn );
	},
	undelegate: function( selector, types, fn ) {
		// ( namespace ) or ( selector, types [, fn] )
		return arguments.length === 1 ? this.off( selector, "**" ) : this.off( types, selector || "**", fn );
	}
});


var nonce = jQuery.now();

var rquery = (/\?/);



var rvalidtokens = /(,)|(\[|{)|(}|])|"(?:[^"\\\r\n]|\\["\\\/bfnrt]|\\u[\da-fA-F]{4})*"\s*:?|true|false|null|-?(?!0\d)\d+(?:\.\d+|)(?:[eE][+-]?\d+|)/g;

jQuery.parseJSON = function( data ) {
	// Attempt to parse using the native JSON parser first
	if ( window.JSON && window.JSON.parse ) {
		// Support: Android 2.3
		// Workaround failure to string-cast null input
		return window.JSON.parse( data + "" );
	}

	var requireNonComma,
		depth = null,
		str = jQuery.trim( data + "" );

	// Guard against invalid (and possibly dangerous) input by ensuring that nothing remains
	// after removing valid tokens
	return str && !jQuery.trim( str.replace( rvalidtokens, function( token, comma, open, close ) {

		// Force termination if we see a misplaced comma
		if ( requireNonComma && comma ) {
			depth = 0;
		}

		// Perform no more replacements after returning to outermost depth
		if ( depth === 0 ) {
			return token;
		}

		// Commas must not follow "[", "{", or ","
		requireNonComma = open || comma;

		// Determine new depth
		// array/object open ("[" or "{"): depth += true - false (increment)
		// array/object close ("]" or "}"): depth += false - true (decrement)
		// other cases ("," or primitive): depth += true - true (numeric cast)
		depth += !close - !open;

		// Remove this token
		return "";
	}) ) ?
		( Function( "return " + str ) )() :
		jQuery.error( "Invalid JSON: " + data );
};


// Cross-browser xml parsing
jQuery.parseXML = function( data ) {
	var xml, tmp;
	if ( !data || typeof data !== "string" ) {
		return null;
	}
	try {
		if ( window.DOMParser ) { // Standard
			tmp = new DOMParser();
			xml = tmp.parseFromString( data, "text/xml" );
		} else { // IE
			xml = new ActiveXObject( "Microsoft.XMLDOM" );
			xml.async = "false";
			xml.loadXML( data );
		}
	} catch( e ) {
		xml = undefined;
	}
	if ( !xml || !xml.documentElement || xml.getElementsByTagName( "parsererror" ).length ) {
		jQuery.error( "Invalid XML: " + data );
	}
	return xml;
};


var
	// Document location
	ajaxLocParts,
	ajaxLocation,

	rhash = /#.*$/,
	rts = /([?&])_=[^&]*/,
	rheaders = /^(.*?):[ \t]*([^\r\n]*)\r?$/mg, // IE leaves an \r character at EOL
	// #7653, #8125, #8152: local protocol detection
	rlocalProtocol = /^(?:about|app|app-storage|.+-extension|file|res|widget):$/,
	rnoContent = /^(?:GET|HEAD)$/,
	rprotocol = /^\/\//,
	rurl = /^([\w.+-]+:)(?:\/\/(?:[^\/?#]*@|)([^\/?#:]*)(?::(\d+)|)|)/,

	/* Prefilters
	 * 1) They are useful to introduce custom dataTypes (see ajax/jsonp.js for an example)
	 * 2) These are called:
	 *    - BEFORE asking for a transport
	 *    - AFTER param serialization (s.data is a string if s.processData is true)
	 * 3) key is the dataType
	 * 4) the catchall symbol "*" can be used
	 * 5) execution will start with transport dataType and THEN continue down to "*" if needed
	 */
	prefilters = {},

	/* Transports bindings
	 * 1) key is the dataType
	 * 2) the catchall symbol "*" can be used
	 * 3) selection will start with transport dataType and THEN go to "*" if needed
	 */
	transports = {},

	// Avoid comment-prolog char sequence (#10098); must appease lint and evade compression
	allTypes = "*/".concat("*");

// #8138, IE may throw an exception when accessing
// a field from window.location if document.domain has been set
try {
	ajaxLocation = location.href;
} catch( e ) {
	// Use the href attribute of an A element
	// since IE will modify it given document.location
	ajaxLocation = document.createElement( "a" );
	ajaxLocation.href = "";
	ajaxLocation = ajaxLocation.href;
}

// Segment location into parts
ajaxLocParts = rurl.exec( ajaxLocation.toLowerCase() ) || [];

// Base "constructor" for jQuery.ajaxPrefilter and jQuery.ajaxTransport
function addToPrefiltersOrTransports( structure ) {

	// dataTypeExpression is optional and defaults to "*"
	return function( dataTypeExpression, func ) {

		if ( typeof dataTypeExpression !== "string" ) {
			func = dataTypeExpression;
			dataTypeExpression = "*";
		}

		var dataType,
			i = 0,
			dataTypes = dataTypeExpression.toLowerCase().match( rnotwhite ) || [];

		if ( jQuery.isFunction( func ) ) {
			// For each dataType in the dataTypeExpression
			while ( (dataType = dataTypes[i++]) ) {
				// Prepend if requested
				if ( dataType.charAt( 0 ) === "+" ) {
					dataType = dataType.slice( 1 ) || "*";
					(structure[ dataType ] = structure[ dataType ] || []).unshift( func );

				// Otherwise append
				} else {
					(structure[ dataType ] = structure[ dataType ] || []).push( func );
				}
			}
		}
	};
}

// Base inspection function for prefilters and transports
function inspectPrefiltersOrTransports( structure, options, originalOptions, jqXHR ) {

	var inspected = {},
		seekingTransport = ( structure === transports );

	function inspect( dataType ) {
		var selected;
		inspected[ dataType ] = true;
		jQuery.each( structure[ dataType ] || [], function( _, prefilterOrFactory ) {
			var dataTypeOrTransport = prefilterOrFactory( options, originalOptions, jqXHR );
			if ( typeof dataTypeOrTransport === "string" && !seekingTransport && !inspected[ dataTypeOrTransport ] ) {
				options.dataTypes.unshift( dataTypeOrTransport );
				inspect( dataTypeOrTransport );
				return false;
			} else if ( seekingTransport ) {
				return !( selected = dataTypeOrTransport );
			}
		});
		return selected;
	}

	return inspect( options.dataTypes[ 0 ] ) || !inspected[ "*" ] && inspect( "*" );
}

// A special extend for ajax options
// that takes "flat" options (not to be deep extended)
// Fixes #9887
function ajaxExtend( target, src ) {
	var deep, key,
		flatOptions = jQuery.ajaxSettings.flatOptions || {};

	for ( key in src ) {
		if ( src[ key ] !== undefined ) {
			( flatOptions[ key ] ? target : ( deep || (deep = {}) ) )[ key ] = src[ key ];
		}
	}
	if ( deep ) {
		jQuery.extend( true, target, deep );
	}

	return target;
}

/* Handles responses to an ajax request:
 * - finds the right dataType (mediates between content-type and expected dataType)
 * - returns the corresponding response
 */
function ajaxHandleResponses( s, jqXHR, responses ) {
	var firstDataType, ct, finalDataType, type,
		contents = s.contents,
		dataTypes = s.dataTypes;

	// Remove auto dataType and get content-type in the process
	while ( dataTypes[ 0 ] === "*" ) {
		dataTypes.shift();
		if ( ct === undefined ) {
			ct = s.mimeType || jqXHR.getResponseHeader("Content-Type");
		}
	}

	// Check if we're dealing with a known content-type
	if ( ct ) {
		for ( type in contents ) {
			if ( contents[ type ] && contents[ type ].test( ct ) ) {
				dataTypes.unshift( type );
				break;
			}
		}
	}

	// Check to see if we have a response for the expected dataType
	if ( dataTypes[ 0 ] in responses ) {
		finalDataType = dataTypes[ 0 ];
	} else {
		// Try convertible dataTypes
		for ( type in responses ) {
			if ( !dataTypes[ 0 ] || s.converters[ type + " " + dataTypes[0] ] ) {
				finalDataType = type;
				break;
			}
			if ( !firstDataType ) {
				firstDataType = type;
			}
		}
		// Or just use first one
		finalDataType = finalDataType || firstDataType;
	}

	// If we found a dataType
	// We add the dataType to the list if needed
	// and return the corresponding response
	if ( finalDataType ) {
		if ( finalDataType !== dataTypes[ 0 ] ) {
			dataTypes.unshift( finalDataType );
		}
		return responses[ finalDataType ];
	}
}

/* Chain conversions given the request and the original response
 * Also sets the responseXXX fields on the jqXHR instance
 */
function ajaxConvert( s, response, jqXHR, isSuccess ) {
	var conv2, current, conv, tmp, prev,
		converters = {},
		// Work with a copy of dataTypes in case we need to modify it for conversion
		dataTypes = s.dataTypes.slice();

	// Create converters map with lowercased keys
	if ( dataTypes[ 1 ] ) {
		for ( conv in s.converters ) {
			converters[ conv.toLowerCase() ] = s.converters[ conv ];
		}
	}

	current = dataTypes.shift();

	// Convert to each sequential dataType
	while ( current ) {

		if ( s.responseFields[ current ] ) {
			jqXHR[ s.responseFields[ current ] ] = response;
		}

		// Apply the dataFilter if provided
		if ( !prev && isSuccess && s.dataFilter ) {
			response = s.dataFilter( response, s.dataType );
		}

		prev = current;
		current = dataTypes.shift();

		if ( current ) {

			// There's only work to do if current dataType is non-auto
			if ( current === "*" ) {

				current = prev;

			// Convert response if prev dataType is non-auto and differs from current
			} else if ( prev !== "*" && prev !== current ) {

				// Seek a direct converter
				conv = converters[ prev + " " + current ] || converters[ "* " + current ];

				// If none found, seek a pair
				if ( !conv ) {
					for ( conv2 in converters ) {

						// If conv2 outputs current
						tmp = conv2.split( " " );
						if ( tmp[ 1 ] === current ) {

							// If prev can be converted to accepted input
							conv = converters[ prev + " " + tmp[ 0 ] ] ||
								converters[ "* " + tmp[ 0 ] ];
							if ( conv ) {
								// Condense equivalence converters
								if ( conv === true ) {
									conv = converters[ conv2 ];

								// Otherwise, insert the intermediate dataType
								} else if ( converters[ conv2 ] !== true ) {
									current = tmp[ 0 ];
									dataTypes.unshift( tmp[ 1 ] );
								}
								break;
							}
						}
					}
				}

				// Apply converter (if not an equivalence)
				if ( conv !== true ) {

					// Unless errors are allowed to bubble, catch and return them
					if ( conv && s[ "throws" ] ) {
						response = conv( response );
					} else {
						try {
							response = conv( response );
						} catch ( e ) {
							return { state: "parsererror", error: conv ? e : "No conversion from " + prev + " to " + current };
						}
					}
				}
			}
		}
	}

	return { state: "success", data: response };
}

jQuery.extend({

	// Counter for holding the number of active queries
	active: 0,

	// Last-Modified header cache for next request
	lastModified: {},
	etag: {},

	ajaxSettings: {
		url: ajaxLocation,
		type: "GET",
		isLocal: rlocalProtocol.test( ajaxLocParts[ 1 ] ),
		global: true,
		processData: true,
		async: true,
		contentType: "application/x-www-form-urlencoded; charset=UTF-8",
		/*
		timeout: 0,
		data: null,
		dataType: null,
		username: null,
		password: null,
		cache: null,
		throws: false,
		traditional: false,
		headers: {},
		*/

		accepts: {
			"*": allTypes,
			text: "text/plain",
			html: "text/html",
			xml: "application/xml, text/xml",
			json: "application/json, text/javascript"
		},

		contents: {
			xml: /xml/,
			html: /html/,
			json: /json/
		},

		responseFields: {
			xml: "responseXML",
			text: "responseText",
			json: "responseJSON"
		},

		// Data converters
		// Keys separate source (or catchall "*") and destination types with a single space
		converters: {

			// Convert anything to text
			"* text": String,

			// Text to html (true = no transformation)
			"text html": true,

			// Evaluate text as a json expression
			"text json": jQuery.parseJSON,

			// Parse text as xml
			"text xml": jQuery.parseXML
		},

		// For options that shouldn't be deep extended:
		// you can add your own custom options here if
		// and when you create one that shouldn't be
		// deep extended (see ajaxExtend)
		flatOptions: {
			url: true,
			context: true
		}
	},

	// Creates a full fledged settings object into target
	// with both ajaxSettings and settings fields.
	// If target is omitted, writes into ajaxSettings.
	ajaxSetup: function( target, settings ) {
		return settings ?

			// Building a settings object
			ajaxExtend( ajaxExtend( target, jQuery.ajaxSettings ), settings ) :

			// Extending ajaxSettings
			ajaxExtend( jQuery.ajaxSettings, target );
	},

	ajaxPrefilter: addToPrefiltersOrTransports( prefilters ),
	ajaxTransport: addToPrefiltersOrTransports( transports ),

	// Main method
	ajax: function( url, options ) {

		// If url is an object, simulate pre-1.5 signature
		if ( typeof url === "object" ) {
			options = url;
			url = undefined;
		}

		// Force options to be an object
		options = options || {};

		var // Cross-domain detection vars
			parts,
			// Loop variable
			i,
			// URL without anti-cache param
			cacheURL,
			// Response headers as string
			responseHeadersString,
			// timeout handle
			timeoutTimer,

			// To know if global events are to be dispatched
			fireGlobals,

			transport,
			// Response headers
			responseHeaders,
			// Create the final options object
			s = jQuery.ajaxSetup( {}, options ),
			// Callbacks context
			callbackContext = s.context || s,
			// Context for global events is callbackContext if it is a DOM node or jQuery collection
			globalEventContext = s.context && ( callbackContext.nodeType || callbackContext.jquery ) ?
				jQuery( callbackContext ) :
				jQuery.event,
			// Deferreds
			deferred = jQuery.Deferred(),
			completeDeferred = jQuery.Callbacks("once memory"),
			// Status-dependent callbacks
			statusCode = s.statusCode || {},
			// Headers (they are sent all at once)
			requestHeaders = {},
			requestHeadersNames = {},
			// The jqXHR state
			state = 0,
			// Default abort message
			strAbort = "canceled",
			// Fake xhr
			jqXHR = {
				readyState: 0,

				// Builds headers hashtable if needed
				getResponseHeader: function( key ) {
					var match;
					if ( state === 2 ) {
						if ( !responseHeaders ) {
							responseHeaders = {};
							while ( (match = rheaders.exec( responseHeadersString )) ) {
								responseHeaders[ match[1].toLowerCase() ] = match[ 2 ];
							}
						}
						match = responseHeaders[ key.toLowerCase() ];
					}
					return match == null ? null : match;
				},

				// Raw string
				getAllResponseHeaders: function() {
					return state === 2 ? responseHeadersString : null;
				},

				// Caches the header
				setRequestHeader: function( name, value ) {
					var lname = name.toLowerCase();
					if ( !state ) {
						name = requestHeadersNames[ lname ] = requestHeadersNames[ lname ] || name;
						requestHeaders[ name ] = value;
					}
					return this;
				},

				// Overrides response content-type header
				overrideMimeType: function( type ) {
					if ( !state ) {
						s.mimeType = type;
					}
					return this;
				},

				// Status-dependent callbacks
				statusCode: function( map ) {
					var code;
					if ( map ) {
						if ( state < 2 ) {
							for ( code in map ) {
								// Lazy-add the new callback in a way that preserves old ones
								statusCode[ code ] = [ statusCode[ code ], map[ code ] ];
							}
						} else {
							// Execute the appropriate callbacks
							jqXHR.always( map[ jqXHR.status ] );
						}
					}
					return this;
				},

				// Cancel the request
				abort: function( statusText ) {
					var finalText = statusText || strAbort;
					if ( transport ) {
						transport.abort( finalText );
					}
					done( 0, finalText );
					return this;
				}
			};

		// Attach deferreds
		deferred.promise( jqXHR ).complete = completeDeferred.add;
		jqXHR.success = jqXHR.done;
		jqXHR.error = jqXHR.fail;

		// Remove hash character (#7531: and string promotion)
		// Add protocol if not provided (#5866: IE7 issue with protocol-less urls)
		// Handle falsy url in the settings object (#10093: consistency with old signature)
		// We also use the url parameter if available
		s.url = ( ( url || s.url || ajaxLocation ) + "" ).replace( rhash, "" ).replace( rprotocol, ajaxLocParts[ 1 ] + "//" );

		// Alias method option to type as per ticket #12004
		s.type = options.method || options.type || s.method || s.type;

		// Extract dataTypes list
		s.dataTypes = jQuery.trim( s.dataType || "*" ).toLowerCase().match( rnotwhite ) || [ "" ];

		// A cross-domain request is in order when we have a protocol:host:port mismatch
		if ( s.crossDomain == null ) {
			parts = rurl.exec( s.url.toLowerCase() );
			s.crossDomain = !!( parts &&
				( parts[ 1 ] !== ajaxLocParts[ 1 ] || parts[ 2 ] !== ajaxLocParts[ 2 ] ||
					( parts[ 3 ] || ( parts[ 1 ] === "http:" ? "80" : "443" ) ) !==
						( ajaxLocParts[ 3 ] || ( ajaxLocParts[ 1 ] === "http:" ? "80" : "443" ) ) )
			);
		}

		// Convert data if not already a string
		if ( s.data && s.processData && typeof s.data !== "string" ) {
			s.data = jQuery.param( s.data, s.traditional );
		}

		// Apply prefilters
		inspectPrefiltersOrTransports( prefilters, s, options, jqXHR );

		// If request was aborted inside a prefilter, stop there
		if ( state === 2 ) {
			return jqXHR;
		}

		// We can fire global events as of now if asked to
		fireGlobals = s.global;

		// Watch for a new set of requests
		if ( fireGlobals && jQuery.active++ === 0 ) {
			jQuery.event.trigger("ajaxStart");
		}

		// Uppercase the type
		s.type = s.type.toUpperCase();

		// Determine if request has content
		s.hasContent = !rnoContent.test( s.type );

		// Save the URL in case we're toying with the If-Modified-Since
		// and/or If-None-Match header later on
		cacheURL = s.url;

		// More options handling for requests with no content
		if ( !s.hasContent ) {

			// If data is available, append data to url
			if ( s.data ) {
				cacheURL = ( s.url += ( rquery.test( cacheURL ) ? "&" : "?" ) + s.data );
				// #9682: remove data so that it's not used in an eventual retry
				delete s.data;
			}

			// Add anti-cache in url if needed
			if ( s.cache === false ) {
				s.url = rts.test( cacheURL ) ?

					// If there is already a '_' parameter, set its value
					cacheURL.replace( rts, "$1_=" + nonce++ ) :

					// Otherwise add one to the end
					cacheURL + ( rquery.test( cacheURL ) ? "&" : "?" ) + "_=" + nonce++;
			}
		}

		// Set the If-Modified-Since and/or If-None-Match header, if in ifModified mode.
		if ( s.ifModified ) {
			if ( jQuery.lastModified[ cacheURL ] ) {
				jqXHR.setRequestHeader( "If-Modified-Since", jQuery.lastModified[ cacheURL ] );
			}
			if ( jQuery.etag[ cacheURL ] ) {
				jqXHR.setRequestHeader( "If-None-Match", jQuery.etag[ cacheURL ] );
			}
		}

		// Set the correct header, if data is being sent
		if ( s.data && s.hasContent && s.contentType !== false || options.contentType ) {
			jqXHR.setRequestHeader( "Content-Type", s.contentType );
		}

		// Set the Accepts header for the server, depending on the dataType
		jqXHR.setRequestHeader(
			"Accept",
			s.dataTypes[ 0 ] && s.accepts[ s.dataTypes[0] ] ?
				s.accepts[ s.dataTypes[0] ] + ( s.dataTypes[ 0 ] !== "*" ? ", " + allTypes + "; q=0.01" : "" ) :
				s.accepts[ "*" ]
		);

		// Check for headers option
		for ( i in s.headers ) {
			jqXHR.setRequestHeader( i, s.headers[ i ] );
		}

		// Allow custom headers/mimetypes and early abort
		if ( s.beforeSend && ( s.beforeSend.call( callbackContext, jqXHR, s ) === false || state === 2 ) ) {
			// Abort if not done already and return
			return jqXHR.abort();
		}

		// aborting is no longer a cancellation
		strAbort = "abort";

		// Install callbacks on deferreds
		for ( i in { success: 1, error: 1, complete: 1 } ) {
			jqXHR[ i ]( s[ i ] );
		}

		// Get transport
		transport = inspectPrefiltersOrTransports( transports, s, options, jqXHR );

		// If no transport, we auto-abort
		if ( !transport ) {
			done( -1, "No Transport" );
		} else {
			jqXHR.readyState = 1;

			// Send global event
			if ( fireGlobals ) {
				globalEventContext.trigger( "ajaxSend", [ jqXHR, s ] );
			}
			// Timeout
			if ( s.async && s.timeout > 0 ) {
				timeoutTimer = setTimeout(function() {
					jqXHR.abort("timeout");
				}, s.timeout );
			}

			try {
				state = 1;
				transport.send( requestHeaders, done );
			} catch ( e ) {
				// Propagate exception as error if not done
				if ( state < 2 ) {
					done( -1, e );
				// Simply rethrow otherwise
				} else {
					throw e;
				}
			}
		}

		// Callback for when everything is done
		function done( status, nativeStatusText, responses, headers ) {
			var isSuccess, success, error, response, modified,
				statusText = nativeStatusText;

			// Called once
			if ( state === 2 ) {
				return;
			}

			// State is "done" now
			state = 2;

			// Clear timeout if it exists
			if ( timeoutTimer ) {
				clearTimeout( timeoutTimer );
			}

			// Dereference transport for early garbage collection
			// (no matter how long the jqXHR object will be used)
			transport = undefined;

			// Cache response headers
			responseHeadersString = headers || "";

			// Set readyState
			jqXHR.readyState = status > 0 ? 4 : 0;

			// Determine if successful
			isSuccess = status >= 200 && status < 300 || status === 304;

			// Get response data
			if ( responses ) {
				response = ajaxHandleResponses( s, jqXHR, responses );
			}

			// Convert no matter what (that way responseXXX fields are always set)
			response = ajaxConvert( s, response, jqXHR, isSuccess );

			// If successful, handle type chaining
			if ( isSuccess ) {

				// Set the If-Modified-Since and/or If-None-Match header, if in ifModified mode.
				if ( s.ifModified ) {
					modified = jqXHR.getResponseHeader("Last-Modified");
					if ( modified ) {
						jQuery.lastModified[ cacheURL ] = modified;
					}
					modified = jqXHR.getResponseHeader("etag");
					if ( modified ) {
						jQuery.etag[ cacheURL ] = modified;
					}
				}

				// if no content
				if ( status === 204 || s.type === "HEAD" ) {
					statusText = "nocontent";

				// if not modified
				} else if ( status === 304 ) {
					statusText = "notmodified";

				// If we have data, let's convert it
				} else {
					statusText = response.state;
					success = response.data;
					error = response.error;
					isSuccess = !error;
				}
			} else {
				// We extract error from statusText
				// then normalize statusText and status for non-aborts
				error = statusText;
				if ( status || !statusText ) {
					statusText = "error";
					if ( status < 0 ) {
						status = 0;
					}
				}
			}

			// Set data for the fake xhr object
			jqXHR.status = status;
			jqXHR.statusText = ( nativeStatusText || statusText ) + "";

			// Success/Error
			if ( isSuccess ) {
				deferred.resolveWith( callbackContext, [ success, statusText, jqXHR ] );
			} else {
				deferred.rejectWith( callbackContext, [ jqXHR, statusText, error ] );
			}

			// Status-dependent callbacks
			jqXHR.statusCode( statusCode );
			statusCode = undefined;

			if ( fireGlobals ) {
				globalEventContext.trigger( isSuccess ? "ajaxSuccess" : "ajaxError",
					[ jqXHR, s, isSuccess ? success : error ] );
			}

			// Complete
			completeDeferred.fireWith( callbackContext, [ jqXHR, statusText ] );

			if ( fireGlobals ) {
				globalEventContext.trigger( "ajaxComplete", [ jqXHR, s ] );
				// Handle the global AJAX counter
				if ( !( --jQuery.active ) ) {
					jQuery.event.trigger("ajaxStop");
				}
			}
		}

		return jqXHR;
	},

	getJSON: function( url, data, callback ) {
		return jQuery.get( url, data, callback, "json" );
	},

	getScript: function( url, callback ) {
		return jQuery.get( url, undefined, callback, "script" );
	}
});

jQuery.each( [ "get", "post" ], function( i, method ) {
	jQuery[ method ] = function( url, data, callback, type ) {
		// shift arguments if data argument was omitted
		if ( jQuery.isFunction( data ) ) {
			type = type || callback;
			callback = data;
			data = undefined;
		}

		return jQuery.ajax({
			url: url,
			type: method,
			dataType: type,
			data: data,
			success: callback
		});
	};
});

// Attach a bunch of functions for handling common AJAX events
jQuery.each( [ "ajaxStart", "ajaxStop", "ajaxComplete", "ajaxError", "ajaxSuccess", "ajaxSend" ], function( i, type ) {
	jQuery.fn[ type ] = function( fn ) {
		return this.on( type, fn );
	};
});


jQuery._evalUrl = function( url ) {
	return jQuery.ajax({
		url: url,
		type: "GET",
		dataType: "script",
		async: false,
		global: false,
		"throws": true
	});
};


jQuery.fn.extend({
	wrapAll: function( html ) {
		if ( jQuery.isFunction( html ) ) {
			return this.each(function(i) {
				jQuery(this).wrapAll( html.call(this, i) );
			});
		}

		if ( this[0] ) {
			// The elements to wrap the target around
			var wrap = jQuery( html, this[0].ownerDocument ).eq(0).clone(true);

			if ( this[0].parentNode ) {
				wrap.insertBefore( this[0] );
			}

			wrap.map(function() {
				var elem = this;

				while ( elem.firstChild && elem.firstChild.nodeType === 1 ) {
					elem = elem.firstChild;
				}

				return elem;
			}).append( this );
		}

		return this;
	},

	wrapInner: function( html ) {
		if ( jQuery.isFunction( html ) ) {
			return this.each(function(i) {
				jQuery(this).wrapInner( html.call(this, i) );
			});
		}

		return this.each(function() {
			var self = jQuery( this ),
				contents = self.contents();

			if ( contents.length ) {
				contents.wrapAll( html );

			} else {
				self.append( html );
			}
		});
	},

	wrap: function( html ) {
		var isFunction = jQuery.isFunction( html );

		return this.each(function(i) {
			jQuery( this ).wrapAll( isFunction ? html.call(this, i) : html );
		});
	},

	unwrap: function() {
		return this.parent().each(function() {
			if ( !jQuery.nodeName( this, "body" ) ) {
				jQuery( this ).replaceWith( this.childNodes );
			}
		}).end();
	}
});


jQuery.expr.filters.hidden = function( elem ) {
	// Support: Opera <= 12.12
	// Opera reports offsetWidths and offsetHeights less than zero on some elements
	return elem.offsetWidth <= 0 && elem.offsetHeight <= 0 ||
		(!support.reliableHiddenOffsets() &&
			((elem.style && elem.style.display) || jQuery.css( elem, "display" )) === "none");
};

jQuery.expr.filters.visible = function( elem ) {
	return !jQuery.expr.filters.hidden( elem );
};




var r20 = /%20/g,
	rbracket = /\[\]$/,
	rCRLF = /\r?\n/g,
	rsubmitterTypes = /^(?:submit|button|image|reset|file)$/i,
	rsubmittable = /^(?:input|select|textarea|keygen)/i;

function buildParams( prefix, obj, traditional, add ) {
	var name;

	if ( jQuery.isArray( obj ) ) {
		// Serialize array item.
		jQuery.each( obj, function( i, v ) {
			if ( traditional || rbracket.test( prefix ) ) {
				// Treat each array item as a scalar.
				add( prefix, v );

			} else {
				// Item is non-scalar (array or object), encode its numeric index.
				buildParams( prefix + "[" + ( typeof v === "object" ? i : "" ) + "]", v, traditional, add );
			}
		});

	} else if ( !traditional && jQuery.type( obj ) === "object" ) {
		// Serialize object item.
		for ( name in obj ) {
			buildParams( prefix + "[" + name + "]", obj[ name ], traditional, add );
		}

	} else {
		// Serialize scalar item.
		add( prefix, obj );
	}
}

// Serialize an array of form elements or a set of
// key/values into a query string
jQuery.param = function( a, traditional ) {
	var prefix,
		s = [],
		add = function( key, value ) {
			// If value is a function, invoke it and return its value
			value = jQuery.isFunction( value ) ? value() : ( value == null ? "" : value );
			s[ s.length ] = encodeURIComponent( key ) + "=" + encodeURIComponent( value );
		};

	// Set traditional to true for jQuery <= 1.3.2 behavior.
	if ( traditional === undefined ) {
		traditional = jQuery.ajaxSettings && jQuery.ajaxSettings.traditional;
	}

	// If an array was passed in, assume that it is an array of form elements.
	if ( jQuery.isArray( a ) || ( a.jquery && !jQuery.isPlainObject( a ) ) ) {
		// Serialize the form elements
		jQuery.each( a, function() {
			add( this.name, this.value );
		});

	} else {
		// If traditional, encode the "old" way (the way 1.3.2 or older
		// did it), otherwise encode params recursively.
		for ( prefix in a ) {
			buildParams( prefix, a[ prefix ], traditional, add );
		}
	}

	// Return the resulting serialization
	return s.join( "&" ).replace( r20, "+" );
};

jQuery.fn.extend({
	serialize: function() {
		return jQuery.param( this.serializeArray() );
	},
	serializeArray: function() {
		return this.map(function() {
			// Can add propHook for "elements" to filter or add form elements
			var elements = jQuery.prop( this, "elements" );
			return elements ? jQuery.makeArray( elements ) : this;
		})
		.filter(function() {
			var type = this.type;
			// Use .is(":disabled") so that fieldset[disabled] works
			return this.name && !jQuery( this ).is( ":disabled" ) &&
				rsubmittable.test( this.nodeName ) && !rsubmitterTypes.test( type ) &&
				( this.checked || !rcheckableType.test( type ) );
		})
		.map(function( i, elem ) {
			var val = jQuery( this ).val();

			return val == null ?
				null :
				jQuery.isArray( val ) ?
					jQuery.map( val, function( val ) {
						return { name: elem.name, value: val.replace( rCRLF, "\r\n" ) };
					}) :
					{ name: elem.name, value: val.replace( rCRLF, "\r\n" ) };
		}).get();
	}
});


// Create the request object
// (This is still attached to ajaxSettings for backward compatibility)
jQuery.ajaxSettings.xhr = window.ActiveXObject !== undefined ?
	// Support: IE6+
	function() {

		// XHR cannot access local files, always use ActiveX for that case
		return !this.isLocal &&

			// Support: IE7-8
			// oldIE XHR does not support non-RFC2616 methods (#13240)
			// See http://msdn.microsoft.com/en-us/library/ie/ms536648(v=vs.85).aspx
			// and http://www.w3.org/Protocols/rfc2616/rfc2616-sec9.html#sec9
			// Although this check for six methods instead of eight
			// since IE also does not support "trace" and "connect"
			/^(get|post|head|put|delete|options)$/i.test( this.type ) &&

			createStandardXHR() || createActiveXHR();
	} :
	// For all other browsers, use the standard XMLHttpRequest object
	createStandardXHR;

var xhrId = 0,
	xhrCallbacks = {},
	xhrSupported = jQuery.ajaxSettings.xhr();

// Support: IE<10
// Open requests must be manually aborted on unload (#5280)
if ( window.ActiveXObject ) {
	jQuery( window ).on( "unload", function() {
		for ( var key in xhrCallbacks ) {
			xhrCallbacks[ key ]( undefined, true );
		}
	});
}

// Determine support properties
support.cors = !!xhrSupported && ( "withCredentials" in xhrSupported );
xhrSupported = support.ajax = !!xhrSupported;

// Create transport if the browser can provide an xhr
if ( xhrSupported ) {

	jQuery.ajaxTransport(function( options ) {
		// Cross domain only allowed if supported through XMLHttpRequest
		if ( !options.crossDomain || support.cors ) {

			var callback;

			return {
				send: function( headers, complete ) {
					var i,
						xhr = options.xhr(),
						id = ++xhrId;

					// Open the socket
					xhr.open( options.type, options.url, options.async, options.username, options.password );

					// Apply custom fields if provided
					if ( options.xhrFields ) {
						for ( i in options.xhrFields ) {
							xhr[ i ] = options.xhrFields[ i ];
						}
					}

					// Override mime type if needed
					if ( options.mimeType && xhr.overrideMimeType ) {
						xhr.overrideMimeType( options.mimeType );
					}

					// X-Requested-With header
					// For cross-domain requests, seeing as conditions for a preflight are
					// akin to a jigsaw puzzle, we simply never set it to be sure.
					// (it can always be set on a per-request basis or even using ajaxSetup)
					// For same-domain requests, won't change header if already provided.
					if ( !options.crossDomain && !headers["X-Requested-With"] ) {
						headers["X-Requested-With"] = "XMLHttpRequest";
					}

					// Set headers
					for ( i in headers ) {
						// Support: IE<9
						// IE's ActiveXObject throws a 'Type Mismatch' exception when setting
						// request header to a null-value.
						//
						// To keep consistent with other XHR implementations, cast the value
						// to string and ignore `undefined`.
						if ( headers[ i ] !== undefined ) {
							xhr.setRequestHeader( i, headers[ i ] + "" );
						}
					}

					// Do send the request
					// This may raise an exception which is actually
					// handled in jQuery.ajax (so no try/catch here)
					xhr.send( ( options.hasContent && options.data ) || null );

					// Listener
					callback = function( _, isAbort ) {
						var status, statusText, responses;

						// Was never called and is aborted or complete
						if ( callback && ( isAbort || xhr.readyState === 4 ) ) {
							// Clean up
							delete xhrCallbacks[ id ];
							callback = undefined;
							xhr.onreadystatechange = jQuery.noop;

							// Abort manually if needed
							if ( isAbort ) {
								if ( xhr.readyState !== 4 ) {
									xhr.abort();
								}
							} else {
								responses = {};
								status = xhr.status;

								// Support: IE<10
								// Accessing binary-data responseText throws an exception
								// (#11426)
								if ( typeof xhr.responseText === "string" ) {
									responses.text = xhr.responseText;
								}

								// Firefox throws an exception when accessing
								// statusText for faulty cross-domain requests
								try {
									statusText = xhr.statusText;
								} catch( e ) {
									// We normalize with Webkit giving an empty statusText
									statusText = "";
								}

								// Filter status for non standard behaviors

								// If the request is local and we have data: assume a success
								// (success with no data won't get notified, that's the best we
								// can do given current implementations)
								if ( !status && options.isLocal && !options.crossDomain ) {
									status = responses.text ? 200 : 404;
								// IE - #1450: sometimes returns 1223 when it should be 204
								} else if ( status === 1223 ) {
									status = 204;
								}
							}
						}

						// Call complete if needed
						if ( responses ) {
							complete( status, statusText, responses, xhr.getAllResponseHeaders() );
						}
					};

					if ( !options.async ) {
						// if we're in sync mode we fire the callback
						callback();
					} else if ( xhr.readyState === 4 ) {
						// (IE6 & IE7) if it's in cache and has been
						// retrieved directly we need to fire the callback
						setTimeout( callback );
					} else {
						// Add to the list of active xhr callbacks
						xhr.onreadystatechange = xhrCallbacks[ id ] = callback;
					}
				},

				abort: function() {
					if ( callback ) {
						callback( undefined, true );
					}
				}
			};
		}
	});
}

// Functions to create xhrs
function createStandardXHR() {
	try {
		return new window.XMLHttpRequest();
	} catch( e ) {}
}

function createActiveXHR() {
	try {
		return new window.ActiveXObject( "Microsoft.XMLHTTP" );
	} catch( e ) {}
}




// Install script dataType
jQuery.ajaxSetup({
	accepts: {
		script: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"
	},
	contents: {
		script: /(?:java|ecma)script/
	},
	converters: {
		"text script": function( text ) {
			jQuery.globalEval( text );
			return text;
		}
	}
});

// Handle cache's special case and global
jQuery.ajaxPrefilter( "script", function( s ) {
	if ( s.cache === undefined ) {
		s.cache = false;
	}
	if ( s.crossDomain ) {
		s.type = "GET";
		s.global = false;
	}
});

// Bind script tag hack transport
jQuery.ajaxTransport( "script", function(s) {

	// This transport only deals with cross domain requests
	if ( s.crossDomain ) {

		var script,
			head = document.head || jQuery("head")[0] || document.documentElement;

		return {

			send: function( _, callback ) {

				script = document.createElement("script");

				script.async = true;

				if ( s.scriptCharset ) {
					script.charset = s.scriptCharset;
				}

				script.src = s.url;

				// Attach handlers for all browsers
				script.onload = script.onreadystatechange = function( _, isAbort ) {

					if ( isAbort || !script.readyState || /loaded|complete/.test( script.readyState ) ) {

						// Handle memory leak in IE
						script.onload = script.onreadystatechange = null;

						// Remove the script
						if ( script.parentNode ) {
							script.parentNode.removeChild( script );
						}

						// Dereference the script
						script = null;

						// Callback if not abort
						if ( !isAbort ) {
							callback( 200, "success" );
						}
					}
				};

				// Circumvent IE6 bugs with base elements (#2709 and #4378) by prepending
				// Use native DOM manipulation to avoid our domManip AJAX trickery
				head.insertBefore( script, head.firstChild );
			},

			abort: function() {
				if ( script ) {
					script.onload( undefined, true );
				}
			}
		};
	}
});




var oldCallbacks = [],
	rjsonp = /(=)\?(?=&|$)|\?\?/;

// Default jsonp settings
jQuery.ajaxSetup({
	jsonp: "callback",
	jsonpCallback: function() {
		var callback = oldCallbacks.pop() || ( jQuery.expando + "_" + ( nonce++ ) );
		this[ callback ] = true;
		return callback;
	}
});

// Detect, normalize options and install callbacks for jsonp requests
jQuery.ajaxPrefilter( "json jsonp", function( s, originalSettings, jqXHR ) {

	var callbackName, overwritten, responseContainer,
		jsonProp = s.jsonp !== false && ( rjsonp.test( s.url ) ?
			"url" :
			typeof s.data === "string" && !( s.contentType || "" ).indexOf("application/x-www-form-urlencoded") && rjsonp.test( s.data ) && "data"
		);

	// Handle iff the expected data type is "jsonp" or we have a parameter to set
	if ( jsonProp || s.dataTypes[ 0 ] === "jsonp" ) {

		// Get callback name, remembering preexisting value associated with it
		callbackName = s.jsonpCallback = jQuery.isFunction( s.jsonpCallback ) ?
			s.jsonpCallback() :
			s.jsonpCallback;

		// Insert callback into url or form data
		if ( jsonProp ) {
			s[ jsonProp ] = s[ jsonProp ].replace( rjsonp, "$1" + callbackName );
		} else if ( s.jsonp !== false ) {
			s.url += ( rquery.test( s.url ) ? "&" : "?" ) + s.jsonp + "=" + callbackName;
		}

		// Use data converter to retrieve json after script execution
		s.converters["script json"] = function() {
			if ( !responseContainer ) {
				jQuery.error( callbackName + " was not called" );
			}
			return responseContainer[ 0 ];
		};

		// force json dataType
		s.dataTypes[ 0 ] = "json";

		// Install callback
		overwritten = window[ callbackName ];
		window[ callbackName ] = function() {
			responseContainer = arguments;
		};

		// Clean-up function (fires after converters)
		jqXHR.always(function() {
			// Restore preexisting value
			window[ callbackName ] = overwritten;

			// Save back as free
			if ( s[ callbackName ] ) {
				// make sure that re-using the options doesn't screw things around
				s.jsonpCallback = originalSettings.jsonpCallback;

				// save the callback name for future use
				oldCallbacks.push( callbackName );
			}

			// Call if it was a function and we have a response
			if ( responseContainer && jQuery.isFunction( overwritten ) ) {
				overwritten( responseContainer[ 0 ] );
			}

			responseContainer = overwritten = undefined;
		});

		// Delegate to script
		return "script";
	}
});




// data: string of html
// context (optional): If specified, the fragment will be created in this context, defaults to document
// keepScripts (optional): If true, will include scripts passed in the html string
jQuery.parseHTML = function( data, context, keepScripts ) {
	if ( !data || typeof data !== "string" ) {
		return null;
	}
	if ( typeof context === "boolean" ) {
		keepScripts = context;
		context = false;
	}
	context = context || document;

	var parsed = rsingleTag.exec( data ),
		scripts = !keepScripts && [];

	// Single tag
	if ( parsed ) {
		return [ context.createElement( parsed[1] ) ];
	}

	parsed = jQuery.buildFragment( [ data ], context, scripts );

	if ( scripts && scripts.length ) {
		jQuery( scripts ).remove();
	}

	return jQuery.merge( [], parsed.childNodes );
};


// Keep a copy of the old load method
var _load = jQuery.fn.load;

/**
 * Load a url into a page
 */
jQuery.fn.load = function( url, params, callback ) {
	if ( typeof url !== "string" && _load ) {
		return _load.apply( this, arguments );
	}

	var selector, response, type,
		self = this,
		off = url.indexOf(" ");

	if ( off >= 0 ) {
		selector = url.slice( off, url.length );
		url = url.slice( 0, off );
	}

	// If it's a function
	if ( jQuery.isFunction( params ) ) {

		// We assume that it's the callback
		callback = params;
		params = undefined;

	// Otherwise, build a param string
	} else if ( params && typeof params === "object" ) {
		type = "POST";
	}

	// If we have elements to modify, make the request
	if ( self.length > 0 ) {
		jQuery.ajax({
			url: url,

			// if "type" variable is undefined, then "GET" method will be used
			type: type,
			dataType: "html",
			data: params
		}).done(function( responseText ) {

			// Save response for use in complete callback
			response = arguments;

			self.html( selector ?

				// If a selector was specified, locate the right elements in a dummy div
				// Exclude scripts to avoid IE 'Permission Denied' errors
				jQuery("<div>").append( jQuery.parseHTML( responseText ) ).find( selector ) :

				// Otherwise use the full result
				responseText );

		}).complete( callback && function( jqXHR, status ) {
			self.each( callback, response || [ jqXHR.responseText, status, jqXHR ] );
		});
	}

	return this;
};




jQuery.expr.filters.animated = function( elem ) {
	return jQuery.grep(jQuery.timers, function( fn ) {
		return elem === fn.elem;
	}).length;
};





var docElem = window.document.documentElement;

/**
 * Gets a window from an element
 */
function getWindow( elem ) {
	return jQuery.isWindow( elem ) ?
		elem :
		elem.nodeType === 9 ?
			elem.defaultView || elem.parentWindow :
			false;
}

jQuery.offset = {
	setOffset: function( elem, options, i ) {
		var curPosition, curLeft, curCSSTop, curTop, curOffset, curCSSLeft, calculatePosition,
			position = jQuery.css( elem, "position" ),
			curElem = jQuery( elem ),
			props = {};

		// set position first, in-case top/left are set even on static elem
		if ( position === "static" ) {
			elem.style.position = "relative";
		}

		curOffset = curElem.offset();
		curCSSTop = jQuery.css( elem, "top" );
		curCSSLeft = jQuery.css( elem, "left" );
		calculatePosition = ( position === "absolute" || position === "fixed" ) &&
			jQuery.inArray("auto", [ curCSSTop, curCSSLeft ] ) > -1;

		// need to be able to calculate position if either top or left is auto and position is either absolute or fixed
		if ( calculatePosition ) {
			curPosition = curElem.position();
			curTop = curPosition.top;
			curLeft = curPosition.left;
		} else {
			curTop = parseFloat( curCSSTop ) || 0;
			curLeft = parseFloat( curCSSLeft ) || 0;
		}

		if ( jQuery.isFunction( options ) ) {
			options = options.call( elem, i, curOffset );
		}

		if ( options.top != null ) {
			props.top = ( options.top - curOffset.top ) + curTop;
		}
		if ( options.left != null ) {
			props.left = ( options.left - curOffset.left ) + curLeft;
		}

		if ( "using" in options ) {
			options.using.call( elem, props );
		} else {
			curElem.css( props );
		}
	}
};

jQuery.fn.extend({
	offset: function( options ) {
		if ( arguments.length ) {
			return options === undefined ?
				this :
				this.each(function( i ) {
					jQuery.offset.setOffset( this, options, i );
				});
		}

		var docElem, win,
			box = { top: 0, left: 0 },
			elem = this[ 0 ],
			doc = elem && elem.ownerDocument;

		if ( !doc ) {
			return;
		}

		docElem = doc.documentElement;

		// Make sure it's not a disconnected DOM node
		if ( !jQuery.contains( docElem, elem ) ) {
			return box;
		}

		// If we don't have gBCR, just use 0,0 rather than error
		// BlackBerry 5, iOS 3 (original iPhone)
		if ( typeof elem.getBoundingClientRect !== strundefined ) {
			box = elem.getBoundingClientRect();
		}
		win = getWindow( doc );
		return {
			top: box.top  + ( win.pageYOffset || docElem.scrollTop )  - ( docElem.clientTop  || 0 ),
			left: box.left + ( win.pageXOffset || docElem.scrollLeft ) - ( docElem.clientLeft || 0 )
		};
	},

	position: function() {
		if ( !this[ 0 ] ) {
			return;
		}

		var offsetParent, offset,
			parentOffset = { top: 0, left: 0 },
			elem = this[ 0 ];

		// fixed elements are offset from window (parentOffset = {top:0, left: 0}, because it is its only offset parent
		if ( jQuery.css( elem, "position" ) === "fixed" ) {
			// we assume that getBoundingClientRect is available when computed position is fixed
			offset = elem.getBoundingClientRect();
		} else {
			// Get *real* offsetParent
			offsetParent = this.offsetParent();

			// Get correct offsets
			offset = this.offset();
			if ( !jQuery.nodeName( offsetParent[ 0 ], "html" ) ) {
				parentOffset = offsetParent.offset();
			}

			// Add offsetParent borders
			parentOffset.top  += jQuery.css( offsetParent[ 0 ], "borderTopWidth", true );
			parentOffset.left += jQuery.css( offsetParent[ 0 ], "borderLeftWidth", true );
		}

		// Subtract parent offsets and element margins
		// note: when an element has margin: auto the offsetLeft and marginLeft
		// are the same in Safari causing offset.left to incorrectly be 0
		return {
			top:  offset.top  - parentOffset.top - jQuery.css( elem, "marginTop", true ),
			left: offset.left - parentOffset.left - jQuery.css( elem, "marginLeft", true)
		};
	},

	offsetParent: function() {
		return this.map(function() {
			var offsetParent = this.offsetParent || docElem;

			while ( offsetParent && ( !jQuery.nodeName( offsetParent, "html" ) && jQuery.css( offsetParent, "position" ) === "static" ) ) {
				offsetParent = offsetParent.offsetParent;
			}
			return offsetParent || docElem;
		});
	}
});

// Create scrollLeft and scrollTop methods
jQuery.each( { scrollLeft: "pageXOffset", scrollTop: "pageYOffset" }, function( method, prop ) {
	var top = /Y/.test( prop );

	jQuery.fn[ method ] = function( val ) {
		return access( this, function( elem, method, val ) {
			var win = getWindow( elem );

			if ( val === undefined ) {
				return win ? (prop in win) ? win[ prop ] :
					win.document.documentElement[ method ] :
					elem[ method ];
			}

			if ( win ) {
				win.scrollTo(
					!top ? val : jQuery( win ).scrollLeft(),
					top ? val : jQuery( win ).scrollTop()
				);

			} else {
				elem[ method ] = val;
			}
		}, method, val, arguments.length, null );
	};
});

// Add the top/left cssHooks using jQuery.fn.position
// Webkit bug: https://bugs.webkit.org/show_bug.cgi?id=29084
// getComputedStyle returns percent when specified for top/left/bottom/right
// rather than make the css module depend on the offset module, we just check for it here
jQuery.each( [ "top", "left" ], function( i, prop ) {
	jQuery.cssHooks[ prop ] = addGetHookIf( support.pixelPosition,
		function( elem, computed ) {
			if ( computed ) {
				computed = curCSS( elem, prop );
				// if curCSS returns percentage, fallback to offset
				return rnumnonpx.test( computed ) ?
					jQuery( elem ).position()[ prop ] + "px" :
					computed;
			}
		}
	);
});


// Create innerHeight, innerWidth, height, width, outerHeight and outerWidth methods
jQuery.each( { Height: "height", Width: "width" }, function( name, type ) {
	jQuery.each( { padding: "inner" + name, content: type, "": "outer" + name }, function( defaultExtra, funcName ) {
		// margin is only for outerHeight, outerWidth
		jQuery.fn[ funcName ] = function( margin, value ) {
			var chainable = arguments.length && ( defaultExtra || typeof margin !== "boolean" ),
				extra = defaultExtra || ( margin === true || value === true ? "margin" : "border" );

			return access( this, function( elem, type, value ) {
				var doc;

				if ( jQuery.isWindow( elem ) ) {
					// As of 5/8/2012 this will yield incorrect results for Mobile Safari, but there
					// isn't a whole lot we can do. See pull request at this URL for discussion:
					// https://github.com/jquery/jquery/pull/764
					return elem.document.documentElement[ "client" + name ];
				}

				// Get document width or height
				if ( elem.nodeType === 9 ) {
					doc = elem.documentElement;

					// Either scroll[Width/Height] or offset[Width/Height] or client[Width/Height], whichever is greatest
					// unfortunately, this causes bug #3838 in IE6/8 only, but there is currently no good, small way to fix it.
					return Math.max(
						elem.body[ "scroll" + name ], doc[ "scroll" + name ],
						elem.body[ "offset" + name ], doc[ "offset" + name ],
						doc[ "client" + name ]
					);
				}

				return value === undefined ?
					// Get width or height on the element, requesting but not forcing parseFloat
					jQuery.css( elem, type, extra ) :

					// Set width or height on the element
					jQuery.style( elem, type, value, extra );
			}, type, chainable ? margin : undefined, chainable, null );
		};
	});
});


// The number of elements contained in the matched element set
jQuery.fn.size = function() {
	return this.length;
};

jQuery.fn.andSelf = jQuery.fn.addBack;




// Register as a named AMD module, since jQuery can be concatenated with other
// files that may use define, but not via a proper concatenation script that
// understands anonymous AMD modules. A named AMD is safest and most robust
// way to register. Lowercase jquery is used because AMD module names are
// derived from file names, and jQuery is normally delivered in a lowercase
// file name. Do this after creating the global so that if an AMD module wants
// to call noConflict to hide this version of jQuery, it will work.
if ( typeof define === "function" && define.amd ) {
	define( "jquery", [], function() {
		return jQuery;
	});
}




var
	// Map over jQuery in case of overwrite
	_jQuery = window.jQuery,

	// Map over the $ in case of overwrite
	_$ = window.$;

jQuery.noConflict = function( deep ) {
	if ( window.$ === jQuery ) {
		window.$ = _$;
	}

	if ( deep && window.jQuery === jQuery ) {
		window.jQuery = _jQuery;
	}

	return jQuery;
};

// Expose jQuery and $ identifiers, even in
// AMD (#7102#comment:10, https://github.com/jquery/jquery/pull/557)
// and CommonJS for browser emulators (#13566)
if ( typeof noGlobal === strundefined ) {
	window.jQuery = window.$ = jQuery;
}




return jQuery;

}));


}).call(this);






(function () {

                                                                                                                     //
// Put jQuery and $ in our exported package-scope variables and remove window.$.
// (Sadly, we don't call noConflict(true), which would also remove
// window.jQuery, because bootstrap very specifically relies on window.jQuery.)
$ = jQuery = window.jQuery.noConflict();


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.jquery = {
  $: $,
  jQuery: jQuery
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;

/* Package-scope variables */
var JSON;

(function () {

                                                                                                          //
// Do we already have a global JSON object? Export it as our JSON object.
if (window.JSON)
  JSON = window.JSON;


}).call(this);






(function () {

                                                                                                          //
/*
    json2.js
    2012-10-08

    Public Domain.

    NO WARRANTY EXPRESSED OR IMPLIED. USE AT YOUR OWN RISK.

    See http://www.JSON.org/js.html


    This code should be minified before deployment.
    See http://javascript.crockford.com/jsmin.html

    USE YOUR OWN COPY. IT IS EXTREMELY UNWISE TO LOAD CODE FROM SERVERS YOU DO
    NOT CONTROL.


    This file creates a global JSON object containing two methods: stringify
    and parse.

        JSON.stringify(value, replacer, space)
            value       any JavaScript value, usually an object or array.

            replacer    an optional parameter that determines how object
                        values are stringified for objects. It can be a
                        function or an array of strings.

            space       an optional parameter that specifies the indentation
                        of nested structures. If it is omitted, the text will
                        be packed without extra whitespace. If it is a number,
                        it will specify the number of spaces to indent at each
                        level. If it is a string (such as '\t' or '&nbsp;'),
                        it contains the characters used to indent at each level.

            This method produces a JSON text from a JavaScript value.

            When an object value is found, if the object contains a toJSON
            method, its toJSON method will be called and the result will be
            stringified. A toJSON method does not serialize: it returns the
            value represented by the name/value pair that should be serialized,
            or undefined if nothing should be serialized. The toJSON method
            will be passed the key associated with the value, and this will be
            bound to the value

            For example, this would serialize Dates as ISO strings.

                Date.prototype.toJSON = function (key) {
                    function f(n) {
                        // Format integers to have at least two digits.
                        return n < 10 ? '0' + n : n;
                    }

                    return this.getUTCFullYear()   + '-' +
                         f(this.getUTCMonth() + 1) + '-' +
                         f(this.getUTCDate())      + 'T' +
                         f(this.getUTCHours())     + ':' +
                         f(this.getUTCMinutes())   + ':' +
                         f(this.getUTCSeconds())   + 'Z';
                };

            You can provide an optional replacer method. It will be passed the
            key and value of each member, with this bound to the containing
            object. The value that is returned from your method will be
            serialized. If your method returns undefined, then the member will
            be excluded from the serialization.

            If the replacer parameter is an array of strings, then it will be
            used to select the members to be serialized. It filters the results
            such that only members with keys listed in the replacer array are
            stringified.

            Values that do not have JSON representations, such as undefined or
            functions, will not be serialized. Such values in objects will be
            dropped; in arrays they will be replaced with null. You can use
            a replacer function to replace those with JSON values.
            JSON.stringify(undefined) returns undefined.

            The optional space parameter produces a stringification of the
            value that is filled with line breaks and indentation to make it
            easier to read.

            If the space parameter is a non-empty string, then that string will
            be used for indentation. If the space parameter is a number, then
            the indentation will be that many spaces.

            Example:

            text = JSON.stringify(['e', {pluribus: 'unum'}]);
            // text is '["e",{"pluribus":"unum"}]'


            text = JSON.stringify(['e', {pluribus: 'unum'}], null, '\t');
            // text is '[\n\t"e",\n\t{\n\t\t"pluribus": "unum"\n\t}\n]'

            text = JSON.stringify([new Date()], function (key, value) {
                return this[key] instanceof Date ?
                    'Date(' + this[key] + ')' : value;
            });
            // text is '["Date(---current time---)"]'


        JSON.parse(text, reviver)
            This method parses a JSON text to produce an object or array.
            It can throw a SyntaxError exception.

            The optional reviver parameter is a function that can filter and
            transform the results. It receives each of the keys and values,
            and its return value is used instead of the original value.
            If it returns what it received, then the structure is not modified.
            If it returns undefined then the member is deleted.

            Example:

            // Parse the text. Values that look like ISO date strings will
            // be converted to Date objects.

            myData = JSON.parse(text, function (key, value) {
                var a;
                if (typeof value === 'string') {
                    a =
/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/.exec(value);
                    if (a) {
                        return new Date(Date.UTC(+a[1], +a[2] - 1, +a[3], +a[4],
                            +a[5], +a[6]));
                    }
                }
                return value;
            });

            myData = JSON.parse('["Date(09/09/2001)"]', function (key, value) {
                var d;
                if (typeof value === 'string' &&
                        value.slice(0, 5) === 'Date(' &&
                        value.slice(-1) === ')') {
                    d = new Date(value.slice(5, -1));
                    if (d) {
                        return d;
                    }
                }
                return value;
            });


    This is a reference implementation. You are free to copy, modify, or
    redistribute.
*/

/*jslint evil: true, regexp: true */

/*members "", "\b", "\t", "\n", "\f", "\r", "\"", JSON, "\\", apply,
    call, charCodeAt, getUTCDate, getUTCFullYear, getUTCHours,
    getUTCMinutes, getUTCMonth, getUTCSeconds, hasOwnProperty, join,
    lastIndex, length, parse, prototype, push, replace, slice, stringify,
    test, toJSON, toString, valueOf
*/


// Create a JSON object only if one does not already exist. We create the
// methods in a closure to avoid creating global variables.

if (typeof JSON !== 'object') {
    JSON = {};
}

(function () {
    'use strict';

    function f(n) {
        // Format integers to have at least two digits.
        return n < 10 ? '0' + n : n;
    }

    if (typeof Date.prototype.toJSON !== 'function') {

        Date.prototype.toJSON = function (key) {

            return isFinite(this.valueOf())
                ? this.getUTCFullYear()     + '-' +
                    f(this.getUTCMonth() + 1) + '-' +
                    f(this.getUTCDate())      + 'T' +
                    f(this.getUTCHours())     + ':' +
                    f(this.getUTCMinutes())   + ':' +
                    f(this.getUTCSeconds())   + 'Z'
                : null;
        };

        String.prototype.toJSON      =
            Number.prototype.toJSON  =
            Boolean.prototype.toJSON = function (key) {
                return this.valueOf();
            };
    }

    var cx = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
        escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
        gap,
        indent,
        meta = {    // table of character substitutions
            '\b': '\\b',
            '\t': '\\t',
            '\n': '\\n',
            '\f': '\\f',
            '\r': '\\r',
            '"' : '\\"',
            '\\': '\\\\'
        },
        rep;


    function quote(string) {

// If the string contains no control characters, no quote characters, and no
// backslash characters, then we can safely slap some quotes around it.
// Otherwise we must also replace the offending characters with safe escape
// sequences.

        escapable.lastIndex = 0;
        return escapable.test(string) ? '"' + string.replace(escapable, function (a) {
            var c = meta[a];
            return typeof c === 'string'
                ? c
                : '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
        }) + '"' : '"' + string + '"';
    }


    function str(key, holder) {

// Produce a string from holder[key].

        var i,          // The loop counter.
            k,          // The member key.
            v,          // The member value.
            length,
            mind = gap,
            partial,
            value = holder[key];

// If the value has a toJSON method, call it to obtain a replacement value.

        if (value && typeof value === 'object' &&
                typeof value.toJSON === 'function') {
            value = value.toJSON(key);
        }

// If we were called with a replacer function, then call the replacer to
// obtain a replacement value.

        if (typeof rep === 'function') {
            value = rep.call(holder, key, value);
        }

// What happens next depends on the value's type.

        switch (typeof value) {
        case 'string':
            return quote(value);

        case 'number':

// JSON numbers must be finite. Encode non-finite numbers as null.

            return isFinite(value) ? String(value) : 'null';

        case 'boolean':
        case 'null':

// If the value is a boolean or null, convert it to a string. Note:
// typeof null does not produce 'null'. The case is included here in
// the remote chance that this gets fixed someday.

            return String(value);

// If the type is 'object', we might be dealing with an object or an array or
// null.

        case 'object':

// Due to a specification blunder in ECMAScript, typeof null is 'object',
// so watch out for that case.

            if (!value) {
                return 'null';
            }

// Make an array to hold the partial results of stringifying this object value.

            gap += indent;
            partial = [];

// Is the value an array?

            if (Object.prototype.toString.apply(value) === '[object Array]') {

// The value is an array. Stringify every element. Use null as a placeholder
// for non-JSON values.

                length = value.length;
                for (i = 0; i < length; i += 1) {
                    partial[i] = str(i, value) || 'null';
                }

// Join all of the elements together, separated with commas, and wrap them in
// brackets.

                v = partial.length === 0
                    ? '[]'
                    : gap
                    ? '[\n' + gap + partial.join(',\n' + gap) + '\n' + mind + ']'
                    : '[' + partial.join(',') + ']';
                gap = mind;
                return v;
            }

// If the replacer is an array, use it to select the members to be stringified.

            if (rep && typeof rep === 'object') {
                length = rep.length;
                for (i = 0; i < length; i += 1) {
                    if (typeof rep[i] === 'string') {
                        k = rep[i];
                        v = str(k, value);
                        if (v) {
                            partial.push(quote(k) + (gap ? ': ' : ':') + v);
                        }
                    }
                }
            } else {

// Otherwise, iterate through all of the keys in the object.

                for (k in value) {
                    if (Object.prototype.hasOwnProperty.call(value, k)) {
                        v = str(k, value);
                        if (v) {
                            partial.push(quote(k) + (gap ? ': ' : ':') + v);
                        }
                    }
                }
            }

// Join all of the member texts together, separated with commas,
// and wrap them in braces.

            v = partial.length === 0
                ? '{}'
                : gap
                ? '{\n' + gap + partial.join(',\n' + gap) + '\n' + mind + '}'
                : '{' + partial.join(',') + '}';
            gap = mind;
            return v;
        }
    }

// If the JSON object does not yet have a stringify method, give it one.

    if (typeof JSON.stringify !== 'function') {
        JSON.stringify = function (value, replacer, space) {

// The stringify method takes a value and an optional replacer, and an optional
// space parameter, and returns a JSON text. The replacer can be a function
// that can replace values, or an array of strings that will select the keys.
// A default replacer method can be provided. Use of the space parameter can
// produce text that is more easily readable.

            var i;
            gap = '';
            indent = '';

// If the space parameter is a number, make an indent string containing that
// many spaces.

            if (typeof space === 'number') {
                for (i = 0; i < space; i += 1) {
                    indent += ' ';
                }

// If the space parameter is a string, it will be used as the indent string.

            } else if (typeof space === 'string') {
                indent = space;
            }

// If there is a replacer, it must be a function or an array.
// Otherwise, throw an error.

            rep = replacer;
            if (replacer && typeof replacer !== 'function' &&
                    (typeof replacer !== 'object' ||
                    typeof replacer.length !== 'number')) {
                throw new Error('JSON.stringify');
            }

// Make a fake root object containing our value under the key of ''.
// Return the result of stringifying the value.

            return str('', {'': value});
        };
    }


// If the JSON object does not yet have a parse method, give it one.

    if (typeof JSON.parse !== 'function') {
        JSON.parse = function (text, reviver) {

// The parse method takes a text and an optional reviver function, and returns
// a JavaScript value if the text is a valid JSON text.

            var j;

            function walk(holder, key) {

// The walk method is used to recursively walk the resulting structure so
// that modifications can be made.

                var k, v, value = holder[key];
                if (value && typeof value === 'object') {
                    for (k in value) {
                        if (Object.prototype.hasOwnProperty.call(value, k)) {
                            v = walk(value, k);
                            if (v !== undefined) {
                                value[k] = v;
                            } else {
                                delete value[k];
                            }
                        }
                    }
                }
                return reviver.call(holder, key, value);
            }


// Parsing happens in four stages. In the first stage, we replace certain
// Unicode characters with escape sequences. JavaScript handles many characters
// incorrectly, either silently deleting them, or treating them as line endings.

            text = String(text);
            cx.lastIndex = 0;
            if (cx.test(text)) {
                text = text.replace(cx, function (a) {
                    return '\\u' +
                        ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
                });
            }

// In the second stage, we run the text against regular expressions that look
// for non-JSON patterns. We are especially concerned with '()' and 'new'
// because they can cause invocation, and '=' because it can cause mutation.
// But just to be safe, we want to reject all unexpected forms.

// We split the second stage into 4 regexp operations in order to work around
// crippling inefficiencies in IE's and Safari's regexp engines. First we
// replace the JSON backslash pairs with '@' (a non-JSON character). Second, we
// replace all simple value tokens with ']' characters. Third, we delete all
// open brackets that follow a colon or comma or that begin the text. Finally,
// we look to see that the remaining characters are only whitespace or ']' or
// ',' or ':' or '{' or '}'. If that is so, then the text is safe for eval.

            if (/^[\],:{}\s]*$/
                    .test(text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, '@')
                        .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
                        .replace(/(?:^|:|,)(?:\s*\[)+/g, ''))) {

// In the third stage we use the eval function to compile the text into a
// JavaScript structure. The '{' operator is subject to a syntactic ambiguity
// in JavaScript: it can begin a block or an object literal. We wrap the text
// in parens to eliminate the ambiguity.

                j = eval('(' + text + ')');

// In the optional fourth stage, we recursively walk the new structure, passing
// each name/value pair to a reviver function for possible transformation.

                return typeof reviver === 'function'
                    ? walk({'': j}, '')
                    : j;
            }

// If the text is not JSON parseable, then a SyntaxError is thrown.

            throw new SyntaxError('JSON.parse');
        };
    }
}());


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.json = {
  JSON: JSON
};

})();



(function () {

/* Imports */
var _ = Package.underscore._;

/* Package-scope variables */
var Meteor;

(function () {

                                                                                                    //
Meteor = {
  isClient: true,
  isServer: false
};

if (typeof __meteor_runtime_config__ === 'object' &&
    __meteor_runtime_config__.PUBLIC_SETTINGS) {
  Meteor.settings = { 'public': __meteor_runtime_config__.PUBLIC_SETTINGS };
}


}).call(this);






(function () {

                                                                                                    //
if (Meteor.isServer)
  var Future = Npm.require('fibers/future');

if (typeof __meteor_runtime_config__ === 'object' &&
    __meteor_runtime_config__.meteorRelease)
  Meteor.release = __meteor_runtime_config__.meteorRelease;

// XXX find a better home for these? Ideally they would be _.get,
// _.ensure, _.delete..

_.extend(Meteor, {
  // _get(a,b,c,d) returns a[b][c][d], or else undefined if a[b] or
  // a[b][c] doesn't exist.
  //
  _get: function (obj /*, arguments */) {
    for (var i = 1; i < arguments.length; i++) {
      if (!(arguments[i] in obj))
        return undefined;
      obj = obj[arguments[i]];
    }
    return obj;
  },

  // _ensure(a,b,c,d) ensures that a[b][c][d] exists. If it does not,
  // it is created and set to {}. Either way, it is returned.
  //
  _ensure: function (obj /*, arguments */) {
    for (var i = 1; i < arguments.length; i++) {
      var key = arguments[i];
      if (!(key in obj))
        obj[key] = {};
      obj = obj[key];
    }

    return obj;
  },

  // _delete(a, b, c, d) deletes a[b][c][d], then a[b][c] unless it
  // isn't empty, then a[b] unless it isn't empty.
  //
  _delete: function (obj /*, arguments */) {
    var stack = [obj];
    var leaf = true;
    for (var i = 1; i < arguments.length - 1; i++) {
      var key = arguments[i];
      if (!(key in obj)) {
        leaf = false;
        break;
      }
      obj = obj[key];
      if (typeof obj !== "object")
        break;
      stack.push(obj);
    }

    for (var i = stack.length - 1; i >= 0; i--) {
      var key = arguments[i+1];

      if (leaf)
        leaf = false;
      else
        for (var other in stack[i][key])
          return; // not empty -- we're done

      delete stack[i][key];
    }
  },

  // _wrapAsync can wrap any function that takes some number of arguments that
  // can't be undefined, followed by some optional arguments, where the callback
  // is the last optional argument.
  // e.g. fs.readFile(pathname, [callback]),
  // fs.open(pathname, flags, [mode], [callback])
  // For maximum effectiveness and least confusion, wrapAsync should be used on
  // functions where the callback is the only argument of type Function.
  //
  _wrapAsync: function (fn) {
    return function (/* arguments */) {
      var self = this;
      var callback;
      var fut;
      var newArgs = _.toArray(arguments);

      var logErr = function (err) {
        if (err)
          return Meteor._debug("Exception in callback of async function",
                               err.stack ? err.stack : err);
      };

      // Pop off optional args that are undefined
      while (newArgs.length > 0 &&
             typeof(newArgs[newArgs.length - 1]) === "undefined") {
        newArgs.pop();
      }
      // If we have any left and the last one is a function, then that's our
      // callback; otherwise, we don't have one.
      if (newArgs.length > 0 &&
          newArgs[newArgs.length - 1] instanceof Function) {
        callback = newArgs.pop();
      } else {
        if (Meteor.isClient) {
          callback = logErr;
        } else {
          fut = new Future();
          callback = fut.resolver();
        }
      }
      newArgs.push(Meteor.bindEnvironment(callback));
      var result = fn.apply(self, newArgs);
      if (fut)
        return fut.wait();
      return result;
    };
  },

  // Sets child's prototype to a new object whose prototype is parent's
  // prototype. Used as:
  //   Meteor._inherits(ClassB, ClassA).
  //   _.extend(ClassB.prototype, { ... })
  // Inspired by CoffeeScript's `extend` and Google Closure's `goog.inherits`.
  _inherits: function (Child, Parent) {
    // copy static fields
    _.each(Parent, function (prop, field) {
      Child[field] = prop;
    });

    // a middle member of prototype chain: takes the prototype from the Parent
    var Middle = function () {
      this.constructor = Child;
    };
    Middle.prototype = Parent.prototype;
    Child.prototype = new Middle();
    Child.__super__ = Parent.prototype;
    return Child;
  }
});


}).call(this);






(function () {

                                                                                                    //
// Chooses one of three setImmediate implementations:
//
// * Native setImmediate (IE 10, Node 0.9+)
//
// * postMessage (many browsers)
//
// * setTimeout  (fallback)
//
// The postMessage implementation is based on
// https://github.com/NobleJS/setImmediate/tree/1.0.1
//
// Don't use `nextTick` for Node since it runs its callbacks before
// I/O, which is stricter than we're looking for.
//
// Not installed as a polyfill, as our public API is `Meteor.defer`.
// Since we're not trying to be a polyfill, we have some
// simplifications:
//
// If one invocation of a setImmediate callback pauses itself by a
// call to alert/prompt/showModelDialog, the NobleJS polyfill
// implementation ensured that no setImmedate callback would run until
// the first invocation completed.  While correct per the spec, what it
// would mean for us in practice is that any reactive updates relying
// on Meteor.defer would be hung in the main window until the modal
// dialog was dismissed.  Thus we only ensure that a setImmediate
// function is called in a later event loop.
//
// We don't need to support using a string to be eval'ed for the
// callback, arguments to the function, or clearImmediate.

"use strict";

var global = this;


// IE 10, Node >= 9.1

function useSetImmediate() {
  if (! global.setImmediate)
    return null;
  else {
    var setImmediate = function (fn) {
      global.setImmediate(fn);
    };
    setImmediate.implementation = 'setImmediate';
    return setImmediate;
  }
}


// Android 2.3.6, Chrome 26, Firefox 20, IE 8-9, iOS 5.1.1 Safari

function usePostMessage() {
  // The test against `importScripts` prevents this implementation
  // from being installed inside a web worker, where
  // `global.postMessage` means something completely different and
  // can't be used for this purpose.

  if (!global.postMessage || global.importScripts) {
    return null;
  }

  // Avoid synchronous post message implementations.

  var postMessageIsAsynchronous = true;
  var oldOnMessage = global.onmessage;
  global.onmessage = function () {
      postMessageIsAsynchronous = false;
  };
  global.postMessage("", "*");
  global.onmessage = oldOnMessage;

  if (! postMessageIsAsynchronous)
    return null;

  var funcIndex = 0;
  var funcs = {};

  // Installs an event handler on `global` for the `message` event: see
  // * https://developer.mozilla.org/en/DOM/window.postMessage
  // * http://www.whatwg.org/specs/web-apps/current-work/multipage/comms.html#crossDocumentMessages

  // XXX use Random.id() here?
  var MESSAGE_PREFIX = "Meteor._setImmediate." + Math.random() + '.';

  function isStringAndStartsWith(string, putativeStart) {
    return (typeof string === "string" &&
            string.substring(0, putativeStart.length) === putativeStart);
  }

  function onGlobalMessage(event) {
    // This will catch all incoming messages (even from other
    // windows!), so we need to try reasonably hard to avoid letting
    // anyone else trick us into firing off. We test the origin is
    // still this window, and that a (randomly generated)
    // unpredictable identifying prefix is present.
    if (event.source === global &&
        isStringAndStartsWith(event.data, MESSAGE_PREFIX)) {
      var index = event.data.substring(MESSAGE_PREFIX.length);
      try {
        if (funcs[index])
          funcs[index]();
      }
      finally {
        delete funcs[index];
      }
    }
  }

  if (global.addEventListener) {
    global.addEventListener("message", onGlobalMessage, false);
  } else {
    global.attachEvent("onmessage", onGlobalMessage);
  }

  var setImmediate = function (fn) {
    // Make `global` post a message to itself with the handle and
    // identifying prefix, thus asynchronously invoking our
    // onGlobalMessage listener above.
    ++funcIndex;
    funcs[funcIndex] = fn;
    global.postMessage(MESSAGE_PREFIX + funcIndex, "*");
  };
  setImmediate.implementation = 'postMessage';
  return setImmediate;
}


function useTimeout() {
  var setImmediate = function (fn) {
    global.setTimeout(fn, 0);
  };
  setImmediate.implementation = 'setTimeout';
  return setImmediate;
}


Meteor._setImmediate =
  useSetImmediate() ||
  usePostMessage() ||
  useTimeout();


}).call(this);






(function () {

                                                                                                    //
var withoutInvocation = function (f) {
  if (Package.livedata) {
    var _CurrentInvocation = Package.livedata.DDP._CurrentInvocation;
    if (_CurrentInvocation.get() && _CurrentInvocation.get().isSimulation)
      throw new Error("Can't set timers inside simulations");
    return function () { _CurrentInvocation.withValue(null, f); };
  }
  else
    return f;
};

var bindAndCatch = function (context, f) {
  return Meteor.bindEnvironment(withoutInvocation(f), context);
};

_.extend(Meteor, {
  // Meteor.setTimeout and Meteor.setInterval callbacks scheduled
  // inside a server method are not part of the method invocation and
  // should clear out the CurrentInvocation environment variable.

  setTimeout: function (f, duration) {
    return setTimeout(bindAndCatch("setTimeout callback", f), duration);
  },

  setInterval: function (f, duration) {
    return setInterval(bindAndCatch("setInterval callback", f), duration);
  },

  clearInterval: function(x) {
    return clearInterval(x);
  },

  clearTimeout: function(x) {
    return clearTimeout(x);
  },

  // XXX consider making this guarantee ordering of defer'd callbacks, like
  // Deps.afterFlush or Node's nextTick (in practice). Then tests can do:
  //    callSomethingThatDefersSomeWork();
  //    Meteor.defer(expect(somethingThatValidatesThatTheWorkHappened));
  defer: function (f) {
    Meteor._setImmediate(bindAndCatch("defer callback", f));
  }
});


}).call(this);






(function () {

                                                                                                    //
// Makes an error subclass which properly contains a stack trace in most
// environments. constructor can set fields on `this` (and should probably set
// `message`, which is what gets displayed at the top of a stack trace).
//
Meteor.makeErrorType = function (name, constructor) {
  var errorClass = function (/*arguments*/) {
    var self = this;

    // Ensure we get a proper stack trace in most Javascript environments
    if (Error.captureStackTrace) {
      // V8 environments (Chrome and Node.js)
      Error.captureStackTrace(self, errorClass);
    } else {
      // Firefox
      var e = new Error;
      e.__proto__ = errorClass.prototype;
      if (e instanceof errorClass)
        self = e;
    }
    // Safari magically works.

    constructor.apply(self, arguments);

    self.errorType = name;

    return self;
  };

  Meteor._inherits(errorClass, Error);

  return errorClass;
};

// This should probably be in the livedata package, but we don't want
// to require you to use the livedata package to get it. Eventually we
// should probably rename it to DDP.Error and put it back in the
// 'livedata' package (which we should rename to 'ddp' also.)
//
// Note: The DDP server assumes that Meteor.Error EJSON-serializes as an object
// containing 'error' and optionally 'reason' and 'details'.
// The DDP client manually puts these into Meteor.Error objects. (We don't use
// EJSON.addType here because the type is determined by location in the
// protocol, not text on the wire.)
//
Meteor.Error = Meteor.makeErrorType(
  "Meteor.Error",
  function (error, reason, details) {
    var self = this;

    // Currently, a numeric code, likely similar to a HTTP code (eg,
    // 404, 500). That is likely to change though.
    self.error = error;

    // Optional: A short human-readable summary of the error. Not
    // intended to be shown to end users, just developers. ("Not Found",
    // "Internal Server Error")
    self.reason = reason;

    // Optional: Additional information about the error, say for
    // debugging. It might be a (textual) stack trace if the server is
    // willing to provide one. The corresponding thing in HTTP would be
    // the body of a 404 or 500 response. (The difference is that we
    // never expect this to be shown to end users, only developers, so
    // it doesn't need to be pretty.)
    self.details = details;

    // This is what gets displayed at the top of a stack trace. Current
    // format is "[404]" (if no reason is set) or "File not found [404]"
    if (self.reason)
      self.message = self.reason + ' [' + self.error + ']';
    else
      self.message = '[' + self.error + ']';
  });

// Meteor.Error is basically data and is sent over DDP, so you should be able to
// properly EJSON-clone it. This is especially important because if a
// Meteor.Error is thrown through a Future, the error, reason, and details
// properties become non-enumerable so a standard Object clone won't preserve
// them and they will be lost from DDP.
Meteor.Error.prototype.clone = function () {
  var self = this;
  return new Meteor.Error(self.error, self.reason, self.details);
};


}).call(this);






(function () {

                                                                                                    //
// This file is a partial analogue to fiber_helpers.js, which allows the client
// to use a queue too, and also to call noYieldsAllowed.

// The client has no ability to yield, so noYieldsAllowed is a noop.
//
Meteor._noYieldsAllowed = function (f) {
  return f();
};

// An even simpler queue of tasks than the fiber-enabled one.  This one just
// runs all the tasks when you call runTask or flush, synchronously.
//
Meteor._SynchronousQueue = function () {
  var self = this;
  self._tasks = [];
  self._running = false;
};

_.extend(Meteor._SynchronousQueue.prototype, {
  runTask: function (task) {
    var self = this;
    if (!self.safeToRunTask())
      throw new Error("Could not synchronously run a task from a running task");
    self._tasks.push(task);
    var tasks = self._tasks;
    self._tasks = [];
    self._running = true;
    try {
      while (!_.isEmpty(tasks)) {
        var t = tasks.shift();
        try {
          t();
        } catch (e) {
          if (_.isEmpty(tasks)) {
            // this was the last task, that is, the one we're calling runTask
            // for.
            throw e;
          } else {
            Meteor._debug("Exception in queued task: " + e.stack);
          }
        }
      }
    } finally {
      self._running = false;
    }
  },

  queueTask: function (task) {
    var self = this;
    var wasEmpty = _.isEmpty(self._tasks);
    self._tasks.push(task);
    // Intentionally not using Meteor.setTimeout, because it doesn't like runing
    // in stubs for now.
    if (wasEmpty)
      setTimeout(_.bind(self.flush, self), 0);
  },

  flush: function () {
    var self = this;
    self.runTask(function () {});
  },

  drain: function () {
    var self = this;
    if (!self.safeToRunTask())
      return;
    while (!_.isEmpty(self._tasks)) {
      self.flush();
    }
  },

  safeToRunTask: function () {
    var self = this;
    return !self._running;
  }
});


}).call(this);






(function () {

                                                                                                    //
var queue = [];
var loaded = document.readyState === "loaded" ||
  document.readyState == "complete";

var ready = function() {
  loaded = true;
  while (queue.length)
    (queue.shift())();
};

if (document.addEventListener) {
  document.addEventListener('DOMContentLoaded', ready, false);
  window.addEventListener('load', ready, false);
} else {
  document.attachEvent('onreadystatechange', function () {
    if (document.readyState === "complete")
      ready();
  });
  window.attachEvent('load', ready);
}

Meteor.startup = function (cb) {
  var doScroll = !document.addEventListener &&
    document.documentElement.doScroll;

  if (!doScroll || window !== top) {
    if (loaded)
      cb();
    else
      queue.push(cb);
  } else {
    try { doScroll('left'); }
    catch (e) {
      setTimeout(function() { Meteor.startup(cb); }, 50);
      return;
    };
    cb();
  }
};


}).call(this);






(function () {

                                                                                                    //
var suppress = 0;

// replacement for console.log. This is a temporary API. We should
// provide a real logging API soon (possibly just a polyfill for
// console?)
//
// NOTE: this is used on the server to print the warning about
// having autopublish enabled when you probably meant to turn it
// off. it's not really the proper use of something called
// _debug. the intent is for this message to go to the terminal and
// be very visible. if you change _debug to go someplace else, etc,
// please fix the autopublish code to do something reasonable.
//
Meteor._debug = function (/* arguments */) {
  if (suppress) {
    suppress--;
    return;
  }
  if (typeof console !== 'undefined' &&
      typeof console.log !== 'undefined') {
    if (arguments.length == 0) { // IE Companion breaks otherwise
      // IE10 PP4 requires at least one argument
      console.log('');
    } else {
      // IE doesn't have console.log.apply, it's not a real Object.
      // http://stackoverflow.com/questions/5538972/console-log-apply-not-working-in-ie9
      // http://patik.com/blog/complete-cross-browser-console-log/
      if (typeof console.log.apply === "function") {
        // Most browsers

        // Chrome and Safari only hyperlink URLs to source files in first argument of
        // console.log, so try to call it with one argument if possible.
        // Approach taken here: If all arguments are strings, join them on space.
        // See https://github.com/meteor/meteor/pull/732#issuecomment-13975991
        var allArgumentsOfTypeString = true;
        for (var i = 0; i < arguments.length; i++)
          if (typeof arguments[i] !== "string")
            allArgumentsOfTypeString = false;

        if (allArgumentsOfTypeString)
          console.log.apply(console, [Array.prototype.join.call(arguments, " ")]);
        else
          console.log.apply(console, arguments);

      } else if (typeof Function.prototype.bind === "function") {
        // IE9
        var log = Function.prototype.bind.call(console.log, console);
        log.apply(console, arguments);
      } else {
        // IE8
        Function.prototype.call.call(console.log, console, Array.prototype.slice.call(arguments));
      }
    }
  }
};

// Suppress the next 'count' Meteor._debug messsages. Use this to
// stop tests from spamming the console.
//
Meteor._suppress_log = function (count) {
  suppress += count;
};


}).call(this);






(function () {

                                                                                                    //
// Simple implementation of dynamic scoping, for use in browsers

var nextSlot = 0;
var currentValues = [];

Meteor.EnvironmentVariable = function () {
  this.slot = nextSlot++;
};

_.extend(Meteor.EnvironmentVariable.prototype, {
  get: function () {
    return currentValues[this.slot];
  },

  getOrNullIfOutsideFiber: function () {
    return this.get();
  },

  withValue: function (value, func) {
    var saved = currentValues[this.slot];
    try {
      currentValues[this.slot] = value;
      var ret = func();
    } finally {
      currentValues[this.slot] = saved;
    }
    return ret;
  }
});

Meteor.bindEnvironment = function (func, onException, _this) {
  // needed in order to be able to create closures inside func and
  // have the closed variables not change back to their original
  // values
  var boundValues = _.clone(currentValues);

  if (!onException || typeof(onException) === 'string') {
    var description = onException || "callback of async function";
    onException = function (error) {
      Meteor._debug(
        "Exception in " + description + ":",
        error && error.stack || error
      );
    };
  }

  return function (/* arguments */) {
    var savedValues = currentValues;
    try {
      currentValues = boundValues;
      var ret = func.apply(_this, _.toArray(arguments));
    } catch (e) {
      // note: callback-hook currently relies on the fact that if onException
      // throws in the browser, the wrapped call throws.
      onException(e);
    } finally {
      currentValues = savedValues;
    }
    return ret;
  };
};

Meteor._nodeCodeMustBeInFiber = function () {
  // no-op on browser
};


}).call(this);






(function () {

                                                                                                    //
Meteor.absoluteUrl = function (path, options) {
  // path is optional
  if (!options && typeof path === 'object') {
    options = path;
    path = undefined;
  }
  // merge options with defaults
  options = _.extend({}, Meteor.absoluteUrl.defaultOptions, options || {});

  var url = options.rootUrl;
  if (!url)
    throw new Error("Must pass options.rootUrl or set ROOT_URL in the server environment");

  if (!/^http[s]?:\/\//i.test(url)) // url starts with 'http://' or 'https://'
    url = 'http://' + url; // we will later fix to https if options.secure is set

  if (!/\/$/.test(url)) // url ends with '/'
    url += '/';

  if (path)
    url += path;

  // turn http to https if secure option is set, and we're not talking
  // to localhost.
  if (options.secure &&
      /^http:/.test(url) && // url starts with 'http:'
      !/http:\/\/localhost[:\/]/.test(url) && // doesn't match localhost
      !/http:\/\/127\.0\.0\.1[:\/]/.test(url)) // or 127.0.0.1
    url = url.replace(/^http:/, 'https:');

  if (options.replaceLocalhost)
    url = url.replace(/^http:\/\/localhost([:\/].*)/, 'http://127.0.0.1$1');

  return url;
};

// allow later packages to override default options
Meteor.absoluteUrl.defaultOptions = { };
if (typeof __meteor_runtime_config__ === "object" &&
    __meteor_runtime_config__.ROOT_URL)
  Meteor.absoluteUrl.defaultOptions.rootUrl = __meteor_runtime_config__.ROOT_URL;


Meteor._relativeToSiteRootUrl = function (link) {
  if (typeof __meteor_runtime_config__ === "object" &&
      link.substr(0, 1) === "/")
    link = (__meteor_runtime_config__.ROOT_URL_PATH_PREFIX || "") + link;
  return link;
};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.meteor = {
  Meteor: Meteor
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var _ = Package.underscore._;
var JSON = Package.json.JSON;
var EJSON = Package.ejson.EJSON;
var IdMap = Package['id-map'].IdMap;
var OrderedDict = Package['ordered-dict'].OrderedDict;
var Deps = Package.deps.Deps;
var Random = Package.random.Random;
var GeoJSON = Package['geojson-utils'].GeoJSON;

/* Package-scope variables */
var LocalCollection, Minimongo, MinimongoTest, MinimongoError, isArray, isPlainObject, isIndexable, isOperatorObject, isNumericKey, regexpElementMatcher, equalityElementMatcher, ELEMENT_OPERATORS, makeLookupFunction, expandArraysInBranches, projectionDetails, pathsToTree;

(function () {

                                                                                                      //
// XXX type checking on selectors (graceful error if malformed)

// LocalCollection: a set of documents that supports queries and modifiers.

// Cursor: a specification for a particular subset of documents, w/
// a defined order, limit, and offset.  creating a Cursor with LocalCollection.find(),

// ObserveHandle: the return value of a live query.

LocalCollection = function (name) {
  var self = this;
  self.name = name;
  // _id -> document (also containing id)
  self._docs = new LocalCollection._IdMap;

  self._observeQueue = new Meteor._SynchronousQueue();

  self.next_qid = 1; // live query id generator

  // qid -> live query object. keys:
  //  ordered: bool. ordered queries have addedBefore/movedBefore callbacks.
  //  results: array (ordered) or object (unordered) of current results
  //    (aliased with self._docs!)
  //  resultsSnapshot: snapshot of results. null if not paused.
  //  cursor: Cursor object for the query.
  //  selector, sorter, (callbacks): functions
  self.queries = {};

  // null if not saving originals; an IdMap from id to original document value if
  // saving originals. See comments before saveOriginals().
  self._savedOriginals = null;

  // True when observers are paused and we should not send callbacks.
  self.paused = false;
};

Minimongo = {};

// Object exported only for unit testing.
// Use it to export private functions to test in Tinytest.
MinimongoTest = {};

LocalCollection._applyChanges = function (doc, changeFields) {
  _.each(changeFields, function (value, key) {
    if (value === undefined)
      delete doc[key];
    else
      doc[key] = value;
  });
};

MinimongoError = function (message) {
  var e = new Error(message);
  e.name = "MinimongoError";
  return e;
};


// options may include sort, skip, limit, reactive
// sort may be any of these forms:
//     {a: 1, b: -1}
//     [["a", "asc"], ["b", "desc"]]
//     ["a", ["b", "desc"]]
//   (in the first form you're beholden to key enumeration order in
//   your javascript VM)
//
// reactive: if given, and false, don't register with Deps (default
// is true)
//
// XXX possibly should support retrieving a subset of fields? and
// have it be a hint (ignored on the client, when not copying the
// doc?)
//
// XXX sort does not yet support subkeys ('a.b') .. fix that!
// XXX add one more sort form: "key"
// XXX tests
LocalCollection.prototype.find = function (selector, options) {
  // default syntax for everything is to omit the selector argument.
  // but if selector is explicitly passed in as false or undefined, we
  // want a selector that matches nothing.
  if (arguments.length === 0)
    selector = {};

  return new LocalCollection.Cursor(this, selector, options);
};

// don't call this ctor directly.  use LocalCollection.find().
LocalCollection.Cursor = function (collection, selector, options) {
  var self = this;
  if (!options) options = {};

  self.collection = collection;
  self.sorter = null;

  if (LocalCollection._selectorIsId(selector)) {
    // stash for fast path
    self._selectorId = selector;
    self.matcher = new Minimongo.Matcher(selector, self);
  } else {
    self._selectorId = undefined;
    self.matcher = new Minimongo.Matcher(selector, self);
    if (self.matcher.hasGeoQuery() || options.sort) {
      self.sorter = new Minimongo.Sorter(options.sort || [],
                                         { matcher: self.matcher });
    }
  }
  self.skip = options.skip;
  self.limit = options.limit;
  self.fields = options.fields;

  if (self.fields)
    self.projectionFn = LocalCollection._compileProjection(self.fields);

  self._transform = LocalCollection.wrapTransform(options.transform);

  // db_objects is an array of the objects that match the cursor. (It's always
  // an array, never an IdMap: LocalCollection.Cursor is always ordered.)
  self.db_objects = null;
  self.cursor_pos = 0;

  // by default, queries register w/ Deps when it is available.
  if (typeof Deps !== "undefined")
    self.reactive = (options.reactive === undefined) ? true : options.reactive;
};

LocalCollection.Cursor.prototype.rewind = function () {
  var self = this;
  self.db_objects = null;
  self.cursor_pos = 0;
};

LocalCollection.prototype.findOne = function (selector, options) {
  if (arguments.length === 0)
    selector = {};

  // NOTE: by setting limit 1 here, we end up using very inefficient
  // code that recomputes the whole query on each update. The upside is
  // that when you reactively depend on a findOne you only get
  // invalidated when the found object changes, not any object in the
  // collection. Most findOne will be by id, which has a fast path, so
  // this might not be a big deal. In most cases, invalidation causes
  // the called to re-query anyway, so this should be a net performance
  // improvement.
  options = options || {};
  options.limit = 1;

  return this.find(selector, options).fetch()[0];
};

LocalCollection.Cursor.prototype.forEach = function (callback, thisArg) {
  var self = this;

  if (self.db_objects === null)
    self.db_objects = self._getRawObjects({ordered: true});

  if (self.reactive)
    self._depend({
      addedBefore: true,
      removed: true,
      changed: true,
      movedBefore: true});

  while (self.cursor_pos < self.db_objects.length) {
    var elt = EJSON.clone(self.db_objects[self.cursor_pos]);
    if (self.projectionFn)
      elt = self.projectionFn(elt);
    if (self._transform)
      elt = self._transform(elt);
    callback.call(thisArg, elt, self.cursor_pos, self);
    ++self.cursor_pos;
  }
};

LocalCollection.Cursor.prototype.getTransform = function () {
  return this._transform;
};

LocalCollection.Cursor.prototype.map = function (callback, thisArg) {
  var self = this;
  var res = [];
  self.forEach(function (doc, index) {
    res.push(callback.call(thisArg, doc, index, self));
  });
  return res;
};

LocalCollection.Cursor.prototype.fetch = function () {
  var self = this;
  var res = [];
  self.forEach(function (doc) {
    res.push(doc);
  });
  return res;
};

LocalCollection.Cursor.prototype.count = function () {
  var self = this;

  if (self.reactive)
    self._depend({added: true, removed: true},
                 true /* allow the observe to be unordered */);

  if (self.db_objects === null)
    self.db_objects = self._getRawObjects({ordered: true});

  return self.db_objects.length;
};

LocalCollection.Cursor.prototype._publishCursor = function (sub) {
  var self = this;
  if (! self.collection.name)
    throw new Error("Can't publish a cursor from a collection without a name.");
  var collection = self.collection.name;

  // XXX minimongo should not depend on mongo-livedata!
  return Meteor.Collection._publishCursor(self, sub, collection);
};

LocalCollection.Cursor.prototype._getCollectionName = function () {
  var self = this;
  return self.collection.name;
};

LocalCollection._observeChangesCallbacksAreOrdered = function (callbacks) {
  if (callbacks.added && callbacks.addedBefore)
    throw new Error("Please specify only one of added() and addedBefore()");
  return !!(callbacks.addedBefore || callbacks.movedBefore);
};

LocalCollection._observeCallbacksAreOrdered = function (callbacks) {
  if (callbacks.addedAt && callbacks.added)
    throw new Error("Please specify only one of added() and addedAt()");
  if (callbacks.changedAt && callbacks.changed)
    throw new Error("Please specify only one of changed() and changedAt()");
  if (callbacks.removed && callbacks.removedAt)
    throw new Error("Please specify only one of removed() and removedAt()");

  return !!(callbacks.addedAt || callbacks.movedTo || callbacks.changedAt
            || callbacks.removedAt);
};

// the handle that comes back from observe.
LocalCollection.ObserveHandle = function () {};

// options to contain:
//  * callbacks for observe():
//    - addedAt (document, atIndex)
//    - added (document)
//    - changedAt (newDocument, oldDocument, atIndex)
//    - changed (newDocument, oldDocument)
//    - removedAt (document, atIndex)
//    - removed (document)
//    - movedTo (document, oldIndex, newIndex)
//
// attributes available on returned query handle:
//  * stop(): end updates
//  * collection: the collection this query is querying
//
// iff x is a returned query handle, (x instanceof
// LocalCollection.ObserveHandle) is true
//
// initial results delivered through added callback
// XXX maybe callbacks should take a list of objects, to expose transactions?
// XXX maybe support field limiting (to limit what you're notified on)

_.extend(LocalCollection.Cursor.prototype, {
  observe: function (options) {
    var self = this;
    return LocalCollection._observeFromObserveChanges(self, options);
  },
  observeChanges: function (options) {
    var self = this;

    var ordered = LocalCollection._observeChangesCallbacksAreOrdered(options);

    // there are several places that assume you aren't combining skip/limit with
    // unordered observe.  eg, update's EJSON.clone, and the "there are several"
    // comment in _modifyAndNotify
    // XXX allow skip/limit with unordered observe
    if (!options._allow_unordered && !ordered && (self.skip || self.limit))
      throw new Error("must use ordered observe with skip or limit");

    if (self.fields && (self.fields._id === 0 || self.fields._id === false))
      throw Error("You may not observe a cursor with {fields: {_id: 0}}");

    var query = {
      matcher: self.matcher, // not fast pathed
      sorter: ordered && self.sorter,
      distances: (
        self.matcher.hasGeoQuery() && ordered && new LocalCollection._IdMap),
      resultsSnapshot: null,
      ordered: ordered,
      cursor: self,
      projectionFn: self.projectionFn
    };
    var qid;

    // Non-reactive queries call added[Before] and then never call anything
    // else.
    if (self.reactive) {
      qid = self.collection.next_qid++;
      self.collection.queries[qid] = query;
    }
    query.results = self._getRawObjects({
      ordered: ordered, distances: query.distances});
    if (self.collection.paused)
      query.resultsSnapshot = (ordered ? [] : new LocalCollection._IdMap);

    // wrap callbacks we were passed. callbacks only fire when not paused and
    // are never undefined
    // Filters out blacklisted fields according to cursor's projection.
    // XXX wrong place for this?

    // furthermore, callbacks enqueue until the operation we're working on is
    // done.
    var wrapCallback = function (f, fieldsIndex, ignoreEmptyFields) {
      if (!f)
        return function () {};
      return function (/*args*/) {
        var context = this;
        var args = arguments;

        if (self.collection.paused)
          return;

        if (fieldsIndex !== undefined && self.projectionFn) {
          args[fieldsIndex] = self.projectionFn(args[fieldsIndex]);
          if (ignoreEmptyFields && _.isEmpty(args[fieldsIndex]))
            return;
        }

        self.collection._observeQueue.queueTask(function () {
          f.apply(context, args);
        });
      };
    };
    query.added = wrapCallback(options.added, 1);
    query.changed = wrapCallback(options.changed, 1, true);
    query.removed = wrapCallback(options.removed);
    if (ordered) {
      query.addedBefore = wrapCallback(options.addedBefore, 1);
      query.movedBefore = wrapCallback(options.movedBefore);
    }

    if (!options._suppress_initial && !self.collection.paused) {
      // XXX unify ordered and unordered interface
      var each = ordered
            ? _.bind(_.each, null, query.results)
            : _.bind(query.results.forEach, query.results);
      each(function (doc) {
        var fields = EJSON.clone(doc);

        delete fields._id;
        if (ordered)
          query.addedBefore(doc._id, fields, null);
        query.added(doc._id, fields);
      });
    }

    var handle = new LocalCollection.ObserveHandle;
    _.extend(handle, {
      collection: self.collection,
      stop: function () {
        if (self.reactive)
          delete self.collection.queries[qid];
      }
    });

    if (self.reactive && Deps.active) {
      // XXX in many cases, the same observe will be recreated when
      // the current autorun is rerun.  we could save work by
      // letting it linger across rerun and potentially get
      // repurposed if the same observe is performed, using logic
      // similar to that of Meteor.subscribe.
      Deps.onInvalidate(function () {
        handle.stop();
      });
    }
    // run the observe callbacks resulting from the initial contents
    // before we leave the observe.
    self.collection._observeQueue.drain();

    return handle;
  }
});

// Returns a collection of matching objects, but doesn't deep copy them.
//
// If ordered is set, returns a sorted array, respecting sorter, skip, and limit
// properties of the query.  if sorter is falsey, no sort -- you get the natural
// order.
//
// If ordered is not set, returns an object mapping from ID to doc (sorter, skip
// and limit should not be set).
//
// If ordered is set and this cursor is a $near geoquery, then this function
// will use an _IdMap to track each distance from the $near argument point in
// order to use it as a sort key. If an _IdMap is passed in the 'distances'
// argument, this function will clear it and use it for this purpose (otherwise
// it will just create its own _IdMap). The observeChanges implementation uses
// this to remember the distances after this function returns.
LocalCollection.Cursor.prototype._getRawObjects = function (options) {
  var self = this;
  options = options || {};

  // XXX use OrderedDict instead of array, and make IdMap and OrderedDict
  // compatible
  var results = options.ordered ? [] : new LocalCollection._IdMap;

  // fast path for single ID value
  if (self._selectorId !== undefined) {
    // If you have non-zero skip and ask for a single id, you get
    // nothing. This is so it matches the behavior of the '{_id: foo}'
    // path.
    if (self.skip)
      return results;

    var selectedDoc = self.collection._docs.get(self._selectorId);
    if (selectedDoc) {
      if (options.ordered)
        results.push(selectedDoc);
      else
        results.set(self._selectorId, selectedDoc);
    }
    return results;
  }

  // slow path for arbitrary selector, sort, skip, limit

  // in the observeChanges case, distances is actually part of the "query" (ie,
  // live results set) object.  in other cases, distances is only used inside
  // this function.
  var distances;
  if (self.matcher.hasGeoQuery() && options.ordered) {
    if (options.distances) {
      distances = options.distances;
      distances.clear();
    } else {
      distances = new LocalCollection._IdMap();
    }
  }

  self.collection._docs.forEach(function (doc, id) {
    var matchResult = self.matcher.documentMatches(doc);
    if (matchResult.result) {
      if (options.ordered) {
        results.push(doc);
        if (distances && matchResult.distance !== undefined)
          distances.set(id, matchResult.distance);
      } else {
        results.set(id, doc);
      }
    }
    // Fast path for limited unsorted queries.
    // XXX 'length' check here seems wrong for ordered
    if (self.limit && !self.skip && !self.sorter &&
        results.length === self.limit)
      return false;  // break
    return true;  // continue
  });

  if (!options.ordered)
    return results;

  if (self.sorter) {
    var comparator = self.sorter.getComparator({distances: distances});
    results.sort(comparator);
  }

  var idx_start = self.skip || 0;
  var idx_end = self.limit ? (self.limit + idx_start) : results.length;
  return results.slice(idx_start, idx_end);
};

// XXX Maybe we need a version of observe that just calls a callback if
// anything changed.
LocalCollection.Cursor.prototype._depend = function (changers, _allow_unordered) {
  var self = this;

  if (Deps.active) {
    var v = new Deps.Dependency;
    v.depend();
    var notifyChange = _.bind(v.changed, v);

    var options = {
      _suppress_initial: true,
      _allow_unordered: _allow_unordered
    };
    _.each(['added', 'changed', 'removed', 'addedBefore', 'movedBefore'],
           function (fnName) {
             if (changers[fnName])
               options[fnName] = notifyChange;
           });

    // observeChanges will stop() when this computation is invalidated
    self.observeChanges(options);
  }
};

// XXX enforce rule that field names can't start with '$' or contain '.'
// (real mongodb does in fact enforce this)
// XXX possibly enforce that 'undefined' does not appear (we assume
// this in our handling of null and $exists)
LocalCollection.prototype.insert = function (doc, callback) {
  var self = this;
  doc = EJSON.clone(doc);

  if (!_.has(doc, '_id')) {
    // if you really want to use ObjectIDs, set this global.
    // Meteor.Collection specifies its own ids and does not use this code.
    doc._id = LocalCollection._useOID ? new LocalCollection._ObjectID()
                                      : Random.id();
  }
  var id = doc._id;

  if (self._docs.has(id))
    throw MinimongoError("Duplicate _id '" + id + "'");

  self._saveOriginal(id, undefined);
  self._docs.set(id, doc);

  var queriesToRecompute = [];
  // trigger live queries that match
  for (var qid in self.queries) {
    var query = self.queries[qid];
    var matchResult = query.matcher.documentMatches(doc);
    if (matchResult.result) {
      if (query.distances && matchResult.distance !== undefined)
        query.distances.set(id, matchResult.distance);
      if (query.cursor.skip || query.cursor.limit)
        queriesToRecompute.push(qid);
      else
        LocalCollection._insertInResults(query, doc);
    }
  }

  _.each(queriesToRecompute, function (qid) {
    if (self.queries[qid])
      LocalCollection._recomputeResults(self.queries[qid]);
  });
  self._observeQueue.drain();

  // Defer because the caller likely doesn't expect the callback to be run
  // immediately.
  if (callback)
    Meteor.defer(function () {
      callback(null, id);
    });
  return id;
};

// Iterates over a subset of documents that could match selector; calls
// f(doc, id) on each of them.  Specifically, if selector specifies
// specific _id's, it only looks at those.  doc is *not* cloned: it is the
// same object that is in _docs.
LocalCollection.prototype._eachPossiblyMatchingDoc = function (selector, f) {
  var self = this;
  var specificIds = LocalCollection._idsMatchedBySelector(selector);
  if (specificIds) {
    for (var i = 0; i < specificIds.length; ++i) {
      var id = specificIds[i];
      var doc = self._docs.get(id);
      if (doc) {
        var breakIfFalse = f(doc, id);
        if (breakIfFalse === false)
          break;
      }
    }
  } else {
    self._docs.forEach(f);
  }
};

LocalCollection.prototype.remove = function (selector, callback) {
  var self = this;

  // Easy special case: if we're not calling observeChanges callbacks and we're
  // not saving originals and we got asked to remove everything, then just empty
  // everything directly.
  if (self.paused && !self._savedOriginals && EJSON.equals(selector, {})) {
    var result = self._docs.size();
    self._docs.clear();
    _.each(self.queries, function (query) {
      if (query.ordered) {
        query.results = [];
      } else {
        query.results.clear();
      }
    });
    if (callback) {
      Meteor.defer(function () {
        callback(null, result);
      });
    }
    return result;
  }

  var matcher = new Minimongo.Matcher(selector, self);
  var remove = [];
  self._eachPossiblyMatchingDoc(selector, function (doc, id) {
    if (matcher.documentMatches(doc).result)
      remove.push(id);
  });

  var queriesToRecompute = [];
  var queryRemove = [];
  for (var i = 0; i < remove.length; i++) {
    var removeId = remove[i];
    var removeDoc = self._docs.get(removeId);
    _.each(self.queries, function (query, qid) {
      if (query.matcher.documentMatches(removeDoc).result) {
        if (query.cursor.skip || query.cursor.limit)
          queriesToRecompute.push(qid);
        else
          queryRemove.push({qid: qid, doc: removeDoc});
      }
    });
    self._saveOriginal(removeId, removeDoc);
    self._docs.remove(removeId);
  }

  // run live query callbacks _after_ we've removed the documents.
  _.each(queryRemove, function (remove) {
    var query = self.queries[remove.qid];
    if (query) {
      query.distances && query.distances.remove(remove.doc._id);
      LocalCollection._removeFromResults(query, remove.doc);
    }
  });
  _.each(queriesToRecompute, function (qid) {
    var query = self.queries[qid];
    if (query)
      LocalCollection._recomputeResults(query);
  });
  self._observeQueue.drain();
  result = remove.length;
  if (callback)
    Meteor.defer(function () {
      callback(null, result);
    });
  return result;
};

// XXX atomicity: if multi is true, and one modification fails, do
// we rollback the whole operation, or what?
LocalCollection.prototype.update = function (selector, mod, options, callback) {
  var self = this;
  if (! callback && options instanceof Function) {
    callback = options;
    options = null;
  }
  if (!options) options = {};

  var matcher = new Minimongo.Matcher(selector, self);

  // Save the original results of any query that we might need to
  // _recomputeResults on, because _modifyAndNotify will mutate the objects in
  // it. (We don't need to save the original results of paused queries because
  // they already have a resultsSnapshot and we won't be diffing in
  // _recomputeResults.)
  var qidToOriginalResults = {};
  _.each(self.queries, function (query, qid) {
    // XXX for now, skip/limit implies ordered observe, so query.results is
    // always an array
    if ((query.cursor.skip || query.cursor.limit) && !query.paused)
      qidToOriginalResults[qid] = EJSON.clone(query.results);
  });
  var recomputeQids = {};

  var updateCount = 0;

  self._eachPossiblyMatchingDoc(selector, function (doc, id) {
    var queryResult = matcher.documentMatches(doc);
    if (queryResult.result) {
      // XXX Should we save the original even if mod ends up being a no-op?
      self._saveOriginal(id, doc);
      self._modifyAndNotify(doc, mod, recomputeQids, queryResult.arrayIndices);
      ++updateCount;
      if (!options.multi)
        return false;  // break
    }
    return true;
  });

  _.each(recomputeQids, function (dummy, qid) {
    var query = self.queries[qid];
    if (query)
      LocalCollection._recomputeResults(query,
                                        qidToOriginalResults[qid]);
  });
  self._observeQueue.drain();

  // If we are doing an upsert, and we didn't modify any documents yet, then
  // it's time to do an insert. Figure out what document we are inserting, and
  // generate an id for it.
  var insertedId;
  if (updateCount === 0 && options.upsert) {
    var newDoc = LocalCollection._removeDollarOperators(selector);
    LocalCollection._modify(newDoc, mod, {isInsert: true});
    if (! newDoc._id && options.insertedId)
      newDoc._id = options.insertedId;
    insertedId = self.insert(newDoc);
    updateCount = 1;
  }

  // Return the number of affected documents, or in the upsert case, an object
  // containing the number of affected docs and the id of the doc that was
  // inserted, if any.
  var result;
  if (options._returnObject) {
    result = {
      numberAffected: updateCount
    };
    if (insertedId !== undefined)
      result.insertedId = insertedId;
  } else {
    result = updateCount;
  }

  if (callback)
    Meteor.defer(function () {
      callback(null, result);
    });
  return result;
};

// A convenience wrapper on update. LocalCollection.upsert(sel, mod) is
// equivalent to LocalCollection.update(sel, mod, { upsert: true, _returnObject:
// true }).
LocalCollection.prototype.upsert = function (selector, mod, options, callback) {
  var self = this;
  if (! callback && typeof options === "function") {
    callback = options;
    options = {};
  }
  return self.update(selector, mod, _.extend({}, options, {
    upsert: true,
    _returnObject: true
  }), callback);
};

LocalCollection.prototype._modifyAndNotify = function (
    doc, mod, recomputeQids, arrayIndices) {
  var self = this;

  var matched_before = {};
  for (var qid in self.queries) {
    var query = self.queries[qid];
    if (query.ordered) {
      matched_before[qid] = query.matcher.documentMatches(doc).result;
    } else {
      // Because we don't support skip or limit (yet) in unordered queries, we
      // can just do a direct lookup.
      matched_before[qid] = query.results.has(doc._id);
    }
  }

  var old_doc = EJSON.clone(doc);

  LocalCollection._modify(doc, mod, {arrayIndices: arrayIndices});

  for (qid in self.queries) {
    query = self.queries[qid];
    var before = matched_before[qid];
    var afterMatch = query.matcher.documentMatches(doc);
    var after = afterMatch.result;
    if (after && query.distances && afterMatch.distance !== undefined)
      query.distances.set(doc._id, afterMatch.distance);

    if (query.cursor.skip || query.cursor.limit) {
      // We need to recompute any query where the doc may have been in the
      // cursor's window either before or after the update. (Note that if skip
      // or limit is set, "before" and "after" being true do not necessarily
      // mean that the document is in the cursor's output after skip/limit is
      // applied... but if they are false, then the document definitely is NOT
      // in the output. So it's safe to skip recompute if neither before or
      // after are true.)
      if (before || after)
        recomputeQids[qid] = true;
    } else if (before && !after) {
      LocalCollection._removeFromResults(query, doc);
    } else if (!before && after) {
      LocalCollection._insertInResults(query, doc);
    } else if (before && after) {
      LocalCollection._updateInResults(query, doc, old_doc);
    }
  }
};

// XXX the sorted-query logic below is laughably inefficient. we'll
// need to come up with a better datastructure for this.
//
// XXX the logic for observing with a skip or a limit is even more
// laughably inefficient. we recompute the whole results every time!

LocalCollection._insertInResults = function (query, doc) {
  var fields = EJSON.clone(doc);
  delete fields._id;
  if (query.ordered) {
    if (!query.sorter) {
      query.addedBefore(doc._id, fields, null);
      query.results.push(doc);
    } else {
      var i = LocalCollection._insertInSortedList(
        query.sorter.getComparator({distances: query.distances}),
        query.results, doc);
      var next = query.results[i+1];
      if (next)
        next = next._id;
      else
        next = null;
      query.addedBefore(doc._id, fields, next);
    }
    query.added(doc._id, fields);
  } else {
    query.added(doc._id, fields);
    query.results.set(doc._id, doc);
  }
};

LocalCollection._removeFromResults = function (query, doc) {
  if (query.ordered) {
    var i = LocalCollection._findInOrderedResults(query, doc);
    query.removed(doc._id);
    query.results.splice(i, 1);
  } else {
    var id = doc._id;  // in case callback mutates doc
    query.removed(doc._id);
    query.results.remove(id);
  }
};

LocalCollection._updateInResults = function (query, doc, old_doc) {
  if (!EJSON.equals(doc._id, old_doc._id))
    throw new Error("Can't change a doc's _id while updating");
  var changedFields = LocalCollection._makeChangedFields(doc, old_doc);
  if (!query.ordered) {
    if (!_.isEmpty(changedFields)) {
      query.changed(doc._id, changedFields);
      query.results.set(doc._id, doc);
    }
    return;
  }

  var orig_idx = LocalCollection._findInOrderedResults(query, doc);

  if (!_.isEmpty(changedFields))
    query.changed(doc._id, changedFields);
  if (!query.sorter)
    return;

  // just take it out and put it back in again, and see if the index
  // changes
  query.results.splice(orig_idx, 1);
  var new_idx = LocalCollection._insertInSortedList(
    query.sorter.getComparator({distances: query.distances}),
    query.results, doc);
  if (orig_idx !== new_idx) {
    var next = query.results[new_idx+1];
    if (next)
      next = next._id;
    else
      next = null;
    query.movedBefore && query.movedBefore(doc._id, next);
  }
};

// Recomputes the results of a query and runs observe callbacks for the
// difference between the previous results and the current results (unless
// paused). Used for skip/limit queries.
//
// When this is used by insert or remove, it can just use query.results for the
// old results (and there's no need to pass in oldResults), because these
// operations don't mutate the documents in the collection. Update needs to pass
// in an oldResults which was deep-copied before the modifier was applied.
LocalCollection._recomputeResults = function (query, oldResults) {
  if (!oldResults)
    oldResults = query.results;
  if (query.distances)
    query.distances.clear();
  query.results = query.cursor._getRawObjects({
    ordered: query.ordered, distances: query.distances});

  if (!query.paused) {
    LocalCollection._diffQueryChanges(
      query.ordered, oldResults, query.results, query);
  }
};


LocalCollection._findInOrderedResults = function (query, doc) {
  if (!query.ordered)
    throw new Error("Can't call _findInOrderedResults on unordered query");
  for (var i = 0; i < query.results.length; i++)
    if (query.results[i] === doc)
      return i;
  throw Error("object missing from query");
};

// This binary search puts a value between any equal values, and the first
// lesser value.
LocalCollection._binarySearch = function (cmp, array, value) {
  var first = 0, rangeLength = array.length;

  while (rangeLength > 0) {
    var halfRange = Math.floor(rangeLength/2);
    if (cmp(value, array[first + halfRange]) >= 0) {
      first += halfRange + 1;
      rangeLength -= halfRange + 1;
    } else {
      rangeLength = halfRange;
    }
  }
  return first;
};

LocalCollection._insertInSortedList = function (cmp, array, value) {
  if (array.length === 0) {
    array.push(value);
    return 0;
  }

  var idx = LocalCollection._binarySearch(cmp, array, value);
  array.splice(idx, 0, value);
  return idx;
};

// To track what documents are affected by a piece of code, call saveOriginals()
// before it and retrieveOriginals() after it. retrieveOriginals returns an
// object whose keys are the ids of the documents that were affected since the
// call to saveOriginals(), and the values are equal to the document's contents
// at the time of saveOriginals. (In the case of an inserted document, undefined
// is the value.) You must alternate between calls to saveOriginals() and
// retrieveOriginals().
LocalCollection.prototype.saveOriginals = function () {
  var self = this;
  if (self._savedOriginals)
    throw new Error("Called saveOriginals twice without retrieveOriginals");
  self._savedOriginals = new LocalCollection._IdMap;
};
LocalCollection.prototype.retrieveOriginals = function () {
  var self = this;
  if (!self._savedOriginals)
    throw new Error("Called retrieveOriginals without saveOriginals");

  var originals = self._savedOriginals;
  self._savedOriginals = null;
  return originals;
};

LocalCollection.prototype._saveOriginal = function (id, doc) {
  var self = this;
  // Are we even trying to save originals?
  if (!self._savedOriginals)
    return;
  // Have we previously mutated the original (and so 'doc' is not actually
  // original)?  (Note the 'has' check rather than truth: we store undefined
  // here for inserted docs!)
  if (self._savedOriginals.has(id))
    return;
  self._savedOriginals.set(id, EJSON.clone(doc));
};

// Pause the observers. No callbacks from observers will fire until
// 'resumeObservers' is called.
LocalCollection.prototype.pauseObservers = function () {
  // No-op if already paused.
  if (this.paused)
    return;

  // Set the 'paused' flag such that new observer messages don't fire.
  this.paused = true;

  // Take a snapshot of the query results for each query.
  for (var qid in this.queries) {
    var query = this.queries[qid];

    query.resultsSnapshot = EJSON.clone(query.results);
  }
};

// Resume the observers. Observers immediately receive change
// notifications to bring them to the current state of the
// database. Note that this is not just replaying all the changes that
// happened during the pause, it is a smarter 'coalesced' diff.
LocalCollection.prototype.resumeObservers = function () {
  var self = this;
  // No-op if not paused.
  if (!this.paused)
    return;

  // Unset the 'paused' flag. Make sure to do this first, otherwise
  // observer methods won't actually fire when we trigger them.
  this.paused = false;

  for (var qid in this.queries) {
    var query = self.queries[qid];
    // Diff the current results against the snapshot and send to observers.
    // pass the query object for its observer callbacks.
    LocalCollection._diffQueryChanges(
      query.ordered, query.resultsSnapshot, query.results, query);
    query.resultsSnapshot = null;
  }
  self._observeQueue.drain();
};


// NB: used by livedata
LocalCollection._idStringify = function (id) {
  if (id instanceof LocalCollection._ObjectID) {
    return id.valueOf();
  } else if (typeof id === 'string') {
    if (id === "") {
      return id;
    } else if (id.substr(0, 1) === "-" || // escape previously dashed strings
               id.substr(0, 1) === "~" || // escape escaped numbers, true, false
               LocalCollection._looksLikeObjectID(id) || // escape object-id-form strings
               id.substr(0, 1) === '{') { // escape object-form strings, for maybe implementing later
      return "-" + id;
    } else {
      return id; // other strings go through unchanged.
    }
  } else if (id === undefined) {
    return '-';
  } else if (typeof id === 'object' && id !== null) {
    throw new Error("Meteor does not currently support objects other than ObjectID as ids");
  } else { // Numbers, true, false, null
    return "~" + JSON.stringify(id);
  }
};


// NB: used by livedata
LocalCollection._idParse = function (id) {
  if (id === "") {
    return id;
  } else if (id === '-') {
    return undefined;
  } else if (id.substr(0, 1) === '-') {
    return id.substr(1);
  } else if (id.substr(0, 1) === '~') {
    return JSON.parse(id.substr(1));
  } else if (LocalCollection._looksLikeObjectID(id)) {
    return new LocalCollection._ObjectID(id);
  } else {
    return id;
  }
};

LocalCollection._makeChangedFields = function (newDoc, oldDoc) {
  var fields = {};
  LocalCollection._diffObjects(oldDoc, newDoc, {
    leftOnly: function (key, value) {
      fields[key] = undefined;
    },
    rightOnly: function (key, value) {
      fields[key] = value;
    },
    both: function (key, leftValue, rightValue) {
      if (!EJSON.equals(leftValue, rightValue))
        fields[key] = rightValue;
    }
  });
  return fields;
};


}).call(this);






(function () {

                                                                                                      //
// Wrap a transform function to return objects that have the _id field
// of the untransformed document. This ensures that subsystems such as
// the observe-sequence package that call `observe` can keep track of
// the documents identities.
//
// - Require that it returns objects
// - If the return value has an _id field, verify that it matches the
//   original _id field
// - If the return value doesn't have an _id field, add it back.
LocalCollection.wrapTransform = function (transform) {
  if (!transform)
    return null;

  return function (doc) {
    if (!_.has(doc, '_id')) {
      // XXX do we ever have a transform on the oplog's collection? because that
      // collection has no _id.
      throw new Error("can only transform documents with _id");
    }

    var id = doc._id;
    // XXX consider making deps a weak dependency and checking Package.deps here
    var transformed = Deps.nonreactive(function () {
      return transform(doc);
    });

    if (!isPlainObject(transformed)) {
      throw new Error("transform must return object");
    }

    if (_.has(transformed, '_id')) {
      if (!EJSON.equals(transformed._id, id)) {
        throw new Error("transformed document can't have different _id");
      }
    } else {
      transformed._id = id;
    }
    return transformed;
  };
};



}).call(this);






(function () {

                                                                                                      //
// Like _.isArray, but doesn't regard polyfilled Uint8Arrays on old browsers as
// arrays.
// XXX maybe this should be EJSON.isArray
isArray = function (x) {
  return _.isArray(x) && !EJSON.isBinary(x);
};

// XXX maybe this should be EJSON.isObject, though EJSON doesn't know about
// RegExp
// XXX note that _type(undefined) === 3!!!!
isPlainObject = LocalCollection._isPlainObject = function (x) {
  return x && LocalCollection._f._type(x) === 3;
};

isIndexable = function (x) {
  return isArray(x) || isPlainObject(x);
};

// Returns true if this is an object with at least one key and all keys begin
// with $.  Unless inconsistentOK is set, throws if some keys begin with $ and
// others don't.
isOperatorObject = function (valueSelector, inconsistentOK) {
  if (!isPlainObject(valueSelector))
    return false;

  var theseAreOperators = undefined;
  _.each(valueSelector, function (value, selKey) {
    var thisIsOperator = selKey.substr(0, 1) === '$';
    if (theseAreOperators === undefined) {
      theseAreOperators = thisIsOperator;
    } else if (theseAreOperators !== thisIsOperator) {
      if (!inconsistentOK)
        throw new Error("Inconsistent operator: " +
                        JSON.stringify(valueSelector));
      theseAreOperators = false;
    }
  });
  return !!theseAreOperators;  // {} has no operators
};


// string can be converted to integer
isNumericKey = function (s) {
  return /^[0-9]+$/.test(s);
};


}).call(this);






(function () {

                                                                                                      //
// The minimongo selector compiler!

// Terminology:
//  - a "selector" is the EJSON object representing a selector
//  - a "matcher" is its compiled form (whether a full Minimongo.Matcher
//    object or one of the component lambdas that matches parts of it)
//  - a "result object" is an object with a "result" field and maybe
//    distance and arrayIndices.
//  - a "branched value" is an object with a "value" field and maybe
//    "dontIterate" and "arrayIndices".
//  - a "document" is a top-level object that can be stored in a collection.
//  - a "lookup function" is a function that takes in a document and returns
//    an array of "branched values".
//  - a "branched matcher" maps from an array of branched values to a result
//    object.
//  - an "element matcher" maps from a single value to a bool.

// Main entry point.
//   var matcher = new Minimongo.Matcher({a: {$gt: 5}});
//   if (matcher.documentMatches({a: 7})) ...
Minimongo.Matcher = function (selector) {
  var self = this;
  // A set (object mapping string -> *) of all of the document paths looked
  // at by the selector. Also includes the empty string if it may look at any
  // path (eg, $where).
  self._paths = {};
  // Set to true if compilation finds a $near.
  self._hasGeoQuery = false;
  // Set to true if compilation finds a $where.
  self._hasWhere = false;
  // Set to false if compilation finds anything other than a simple equality or
  // one or more of '$gt', '$gte', '$lt', '$lte', '$ne', '$in', '$nin' used with
  // scalars as operands.
  self._isSimple = true;
  // Set to a dummy document which always matches this Matcher. Or set to null
  // if such document is too hard to find.
  self._matchingDocument = undefined;
  // A clone of the original selector. It may just be a function if the user
  // passed in a function; otherwise is definitely an object (eg, IDs are
  // translated into {_id: ID} first. Used by canBecomeTrueByModifier and
  // Sorter._useWithMatcher.
  self._selector = null;
  self._docMatcher = self._compileSelector(selector);
};

_.extend(Minimongo.Matcher.prototype, {
  documentMatches: function (doc) {
    if (!doc || typeof doc !== "object") {
      throw Error("documentMatches needs a document");
    }
    return this._docMatcher(doc);
  },
  hasGeoQuery: function () {
    return this._hasGeoQuery;
  },
  hasWhere: function () {
    return this._hasWhere;
  },
  isSimple: function () {
    return this._isSimple;
  },

  // Given a selector, return a function that takes one argument, a
  // document. It returns a result object.
  _compileSelector: function (selector) {
    var self = this;
    // you can pass a literal function instead of a selector
    if (selector instanceof Function) {
      self._isSimple = false;
      self._selector = selector;
      self._recordPathUsed('');
      return function (doc) {
        return {result: !!selector.call(doc)};
      };
    }

    // shorthand -- scalars match _id
    if (LocalCollection._selectorIsId(selector)) {
      self._selector = {_id: selector};
      self._recordPathUsed('_id');
      return function (doc) {
        return {result: EJSON.equals(doc._id, selector)};
      };
    }

    // protect against dangerous selectors.  falsey and {_id: falsey} are both
    // likely programmer error, and not what you want, particularly for
    // destructive operations.
    if (!selector || (('_id' in selector) && !selector._id)) {
      self._isSimple = false;
      return nothingMatcher;
    }

    // Top level can't be an array or true or binary.
    if (typeof(selector) === 'boolean' || isArray(selector) ||
        EJSON.isBinary(selector))
      throw new Error("Invalid selector: " + selector);

    self._selector = EJSON.clone(selector);
    return compileDocumentSelector(selector, self, {isRoot: true});
  },
  _recordPathUsed: function (path) {
    this._paths[path] = true;
  },
  // Returns a list of key paths the given selector is looking for. It includes
  // the empty string if there is a $where.
  _getPaths: function () {
    return _.keys(this._paths);
  }
});


// Takes in a selector that could match a full document (eg, the original
// selector). Returns a function mapping document->result object.
//
// matcher is the Matcher object we are compiling.
//
// If this is the root document selector (ie, not wrapped in $and or the like),
// then isRoot is true. (This is used by $near.)
var compileDocumentSelector = function (docSelector, matcher, options) {
  options = options || {};
  var docMatchers = [];
  _.each(docSelector, function (subSelector, key) {
    if (key.substr(0, 1) === '$') {
      // Outer operators are either logical operators (they recurse back into
      // this function), or $where.
      if (!_.has(LOGICAL_OPERATORS, key))
        throw new Error("Unrecognized logical operator: " + key);
      matcher._isSimple = false;
      docMatchers.push(LOGICAL_OPERATORS[key](subSelector, matcher,
                                              options.inElemMatch));
    } else {
      // Record this path, but only if we aren't in an elemMatcher, since in an
      // elemMatch this is a path inside an object in an array, not in the doc
      // root.
      if (!options.inElemMatch)
        matcher._recordPathUsed(key);
      var lookUpByIndex = makeLookupFunction(key);
      var valueMatcher =
        compileValueSelector(subSelector, matcher, options.isRoot);
      docMatchers.push(function (doc) {
        var branchValues = lookUpByIndex(doc);
        return valueMatcher(branchValues);
      });
    }
  });

  return andDocumentMatchers(docMatchers);
};

// Takes in a selector that could match a key-indexed value in a document; eg,
// {$gt: 5, $lt: 9}, or a regular expression, or any non-expression object (to
// indicate equality).  Returns a branched matcher: a function mapping
// [branched value]->result object.
var compileValueSelector = function (valueSelector, matcher, isRoot) {
  if (valueSelector instanceof RegExp) {
    matcher._isSimple = false;
    return convertElementMatcherToBranchedMatcher(
      regexpElementMatcher(valueSelector));
  } else if (isOperatorObject(valueSelector)) {
    return operatorBranchedMatcher(valueSelector, matcher, isRoot);
  } else {
    return convertElementMatcherToBranchedMatcher(
      equalityElementMatcher(valueSelector));
  }
};

// Given an element matcher (which evaluates a single value), returns a branched
// value (which evaluates the element matcher on all the branches and returns a
// more structured return value possibly including arrayIndices).
var convertElementMatcherToBranchedMatcher = function (
    elementMatcher, options) {
  options = options || {};
  return function (branches) {
    var expanded = branches;
    if (!options.dontExpandLeafArrays) {
      expanded = expandArraysInBranches(
        branches, options.dontIncludeLeafArrays);
    }
    var ret = {};
    ret.result = _.any(expanded, function (element) {
      var matched = elementMatcher(element.value);

      // Special case for $elemMatch: it means "true, and use this as an array
      // index if I didn't already have one".
      if (typeof matched === 'number') {
        // XXX This code dates from when we only stored a single array index
        // (for the outermost array). Should we be also including deeper array
        // indices from the $elemMatch match?
        if (!element.arrayIndices)
          element.arrayIndices = [matched];
        matched = true;
      }

      // If some element matched, and it's tagged with array indices, include
      // those indices in our result object.
      if (matched && element.arrayIndices)
        ret.arrayIndices = element.arrayIndices;

      return matched;
    });
    return ret;
  };
};

// Takes a RegExp object and returns an element matcher.
regexpElementMatcher = function (regexp) {
  return function (value) {
    if (value instanceof RegExp) {
      // Comparing two regexps means seeing if the regexps are identical
      // (really!). Underscore knows how.
      return _.isEqual(value, regexp);
    }
    // Regexps only work against strings.
    if (typeof value !== 'string')
      return false;
    return regexp.test(value);
  };
};

// Takes something that is not an operator object and returns an element matcher
// for equality with that thing.
equalityElementMatcher = function (elementSelector) {
  if (isOperatorObject(elementSelector))
    throw Error("Can't create equalityValueSelector for operator object");

  // Special-case: null and undefined are equal (if you got undefined in there
  // somewhere, or if you got it due to some branch being non-existent in the
  // weird special case), even though they aren't with EJSON.equals.
  if (elementSelector == null) {  // undefined or null
    return function (value) {
      return value == null;  // undefined or null
    };
  }

  return function (value) {
    return LocalCollection._f._equal(elementSelector, value);
  };
};

// Takes an operator object (an object with $ keys) and returns a branched
// matcher for it.
var operatorBranchedMatcher = function (valueSelector, matcher, isRoot) {
  // Each valueSelector works separately on the various branches.  So one
  // operator can match one branch and another can match another branch.  This
  // is OK.

  var operatorMatchers = [];
  _.each(valueSelector, function (operand, operator) {
    // XXX we should actually implement $eq, which is new in 2.6
    var simpleRange = _.contains(['$lt', '$lte', '$gt', '$gte'], operator) &&
      _.isNumber(operand);
    var simpleInequality = operator === '$ne' && !_.isObject(operand);
    var simpleInclusion = _.contains(['$in', '$nin'], operator) &&
      _.isArray(operand) && !_.any(operand, _.isObject);

    if (! (operator === '$eq' || simpleRange ||
           simpleInclusion || simpleInequality)) {
      matcher._isSimple = false;
    }

    if (_.has(VALUE_OPERATORS, operator)) {
      operatorMatchers.push(
        VALUE_OPERATORS[operator](operand, valueSelector, matcher, isRoot));
    } else if (_.has(ELEMENT_OPERATORS, operator)) {
      var options = ELEMENT_OPERATORS[operator];
      operatorMatchers.push(
        convertElementMatcherToBranchedMatcher(
          options.compileElementSelector(
            operand, valueSelector, matcher),
          options));
    } else {
      throw new Error("Unrecognized operator: " + operator);
    }
  });

  return andBranchedMatchers(operatorMatchers);
};

var compileArrayOfDocumentSelectors = function (
    selectors, matcher, inElemMatch) {
  if (!isArray(selectors) || _.isEmpty(selectors))
    throw Error("$and/$or/$nor must be nonempty array");
  return _.map(selectors, function (subSelector) {
    if (!isPlainObject(subSelector))
      throw Error("$or/$and/$nor entries need to be full objects");
    return compileDocumentSelector(
      subSelector, matcher, {inElemMatch: inElemMatch});
  });
};

// Operators that appear at the top level of a document selector.
var LOGICAL_OPERATORS = {
  $and: function (subSelector, matcher, inElemMatch) {
    var matchers = compileArrayOfDocumentSelectors(
      subSelector, matcher, inElemMatch);
    return andDocumentMatchers(matchers);
  },

  $or: function (subSelector, matcher, inElemMatch) {
    var matchers = compileArrayOfDocumentSelectors(
      subSelector, matcher, inElemMatch);

    // Special case: if there is only one matcher, use it directly, *preserving*
    // any arrayIndices it returns.
    if (matchers.length === 1)
      return matchers[0];

    return function (doc) {
      var result = _.any(matchers, function (f) {
        return f(doc).result;
      });
      // $or does NOT set arrayIndices when it has multiple
      // sub-expressions. (Tested against MongoDB.)
      return {result: result};
    };
  },

  $nor: function (subSelector, matcher, inElemMatch) {
    var matchers = compileArrayOfDocumentSelectors(
      subSelector, matcher, inElemMatch);
    return function (doc) {
      var result = _.all(matchers, function (f) {
        return !f(doc).result;
      });
      // Never set arrayIndices, because we only match if nothing in particular
      // "matched" (and because this is consistent with MongoDB).
      return {result: result};
    };
  },

  $where: function (selectorValue, matcher) {
    // Record that *any* path may be used.
    matcher._recordPathUsed('');
    matcher._hasWhere = true;
    if (!(selectorValue instanceof Function)) {
      // XXX MongoDB seems to have more complex logic to decide where or or not
      // to add "return"; not sure exactly what it is.
      selectorValue = Function("obj", "return " + selectorValue);
    }
    return function (doc) {
      // We make the document available as both `this` and `obj`.
      // XXX not sure what we should do if this throws
      return {result: selectorValue.call(doc, doc)};
    };
  },

  // This is just used as a comment in the query (in MongoDB, it also ends up in
  // query logs); it has no effect on the actual selection.
  $comment: function () {
    return function () {
      return {result: true};
    };
  }
};

// Returns a branched matcher that matches iff the given matcher does not.
// Note that this implicitly "deMorganizes" the wrapped function.  ie, it
// means that ALL branch values need to fail to match innerBranchedMatcher.
var invertBranchedMatcher = function (branchedMatcher) {
  return function (branchValues) {
    var invertMe = branchedMatcher(branchValues);
    // We explicitly choose to strip arrayIndices here: it doesn't make sense to
    // say "update the array element that does not match something", at least
    // in mongo-land.
    return {result: !invertMe.result};
  };
};

// Operators that (unlike LOGICAL_OPERATORS) pertain to individual paths in a
// document, but (unlike ELEMENT_OPERATORS) do not have a simple definition as
// "match each branched value independently and combine with
// convertElementMatcherToBranchedMatcher".
var VALUE_OPERATORS = {
  $not: function (operand, valueSelector, matcher) {
    return invertBranchedMatcher(compileValueSelector(operand, matcher));
  },
  $ne: function (operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(
      equalityElementMatcher(operand)));
  },
  $nin: function (operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(
      ELEMENT_OPERATORS.$in.compileElementSelector(operand)));
  },
  $exists: function (operand) {
    var exists = convertElementMatcherToBranchedMatcher(function (value) {
      return value !== undefined;
    });
    return operand ? exists : invertBranchedMatcher(exists);
  },
  // $options just provides options for $regex; its logic is inside $regex
  $options: function (operand, valueSelector) {
    if (!_.has(valueSelector, '$regex'))
      throw Error("$options needs a $regex");
    return everythingMatcher;
  },
  // $maxDistance is basically an argument to $near
  $maxDistance: function (operand, valueSelector) {
    if (!valueSelector.$near)
      throw Error("$maxDistance needs a $near");
    return everythingMatcher;
  },
  $all: function (operand, valueSelector, matcher) {
    if (!isArray(operand))
      throw Error("$all requires array");
    // Not sure why, but this seems to be what MongoDB does.
    if (_.isEmpty(operand))
      return nothingMatcher;

    var branchedMatchers = [];
    _.each(operand, function (criterion) {
      // XXX handle $all/$elemMatch combination
      if (isOperatorObject(criterion))
        throw Error("no $ expressions in $all");
      // This is always a regexp or equality selector.
      branchedMatchers.push(compileValueSelector(criterion, matcher));
    });
    // andBranchedMatchers does NOT require all selectors to return true on the
    // SAME branch.
    return andBranchedMatchers(branchedMatchers);
  },
  $near: function (operand, valueSelector, matcher, isRoot) {
    if (!isRoot)
      throw Error("$near can't be inside another $ operator");
    matcher._hasGeoQuery = true;

    // There are two kinds of geodata in MongoDB: coordinate pairs and
    // GeoJSON. They use different distance metrics, too. GeoJSON queries are
    // marked with a $geometry property.

    var maxDistance, point, distance;
    if (isPlainObject(operand) && _.has(operand, '$geometry')) {
      // GeoJSON "2dsphere" mode.
      maxDistance = operand.$maxDistance;
      point = operand.$geometry;
      distance = function (value) {
        // XXX: for now, we don't calculate the actual distance between, say,
        // polygon and circle. If people care about this use-case it will get
        // a priority.
        if (!value || !value.type)
          return null;
        if (value.type === "Point") {
          return GeoJSON.pointDistance(point, value);
        } else {
          return GeoJSON.geometryWithinRadius(value, point, maxDistance)
            ? 0 : maxDistance + 1;
        }
      };
    } else {
      maxDistance = valueSelector.$maxDistance;
      if (!isArray(operand) && !isPlainObject(operand))
        throw Error("$near argument must be coordinate pair or GeoJSON");
      point = pointToArray(operand);
      distance = function (value) {
        if (!isArray(value) && !isPlainObject(value))
          return null;
        return distanceCoordinatePairs(point, value);
      };
    }

    return function (branchedValues) {
      // There might be multiple points in the document that match the given
      // field. Only one of them needs to be within $maxDistance, but we need to
      // evaluate all of them and use the nearest one for the implicit sort
      // specifier. (That's why we can't just use ELEMENT_OPERATORS here.)
      //
      // Note: This differs from MongoDB's implementation, where a document will
      // actually show up *multiple times* in the result set, with one entry for
      // each within-$maxDistance branching point.
      branchedValues = expandArraysInBranches(branchedValues);
      var result = {result: false};
      _.each(branchedValues, function (branch) {
        var curDistance = distance(branch.value);
        // Skip branches that aren't real points or are too far away.
        if (curDistance === null || curDistance > maxDistance)
          return;
        // Skip anything that's a tie.
        if (result.distance !== undefined && result.distance <= curDistance)
          return;
        result.result = true;
        result.distance = curDistance;
        if (!branch.arrayIndices)
          delete result.arrayIndices;
        else
          result.arrayIndices = branch.arrayIndices;
      });
      return result;
    };
  }
};

// Helpers for $near.
var distanceCoordinatePairs = function (a, b) {
  a = pointToArray(a);
  b = pointToArray(b);
  var x = a[0] - b[0];
  var y = a[1] - b[1];
  if (_.isNaN(x) || _.isNaN(y))
    return null;
  return Math.sqrt(x * x + y * y);
};
// Makes sure we get 2 elements array and assume the first one to be x and
// the second one to y no matter what user passes.
// In case user passes { lon: x, lat: y } returns [x, y]
var pointToArray = function (point) {
  return _.map(point, _.identity);
};

// Helper for $lt/$gt/$lte/$gte.
var makeInequality = function (cmpValueComparator) {
  return {
    compileElementSelector: function (operand) {
      // Arrays never compare false with non-arrays for any inequality.
      // XXX This was behavior we observed in pre-release MongoDB 2.5, but
      //     it seems to have been reverted.
      //     See https://jira.mongodb.org/browse/SERVER-11444
      if (isArray(operand)) {
        return function () {
          return false;
        };
      }

      // Special case: consider undefined and null the same (so true with
      // $gte/$lte).
      if (operand === undefined)
        operand = null;

      var operandType = LocalCollection._f._type(operand);

      return function (value) {
        if (value === undefined)
          value = null;
        // Comparisons are never true among things of different type (except
        // null vs undefined).
        if (LocalCollection._f._type(value) !== operandType)
          return false;
        return cmpValueComparator(LocalCollection._f._cmp(value, operand));
      };
    }
  };
};

// Each element selector contains:
//  - compileElementSelector, a function with args:
//    - operand - the "right hand side" of the operator
//    - valueSelector - the "context" for the operator (so that $regex can find
//      $options)
//    - matcher - the Matcher this is going into (so that $elemMatch can compile
//      more things)
//    returning a function mapping a single value to bool.
//  - dontExpandLeafArrays, a bool which prevents expandArraysInBranches from
//    being called
//  - dontIncludeLeafArrays, a bool which causes an argument to be passed to
//    expandArraysInBranches if it is called
ELEMENT_OPERATORS = {
  $lt: makeInequality(function (cmpValue) {
    return cmpValue < 0;
  }),
  $gt: makeInequality(function (cmpValue) {
    return cmpValue > 0;
  }),
  $lte: makeInequality(function (cmpValue) {
    return cmpValue <= 0;
  }),
  $gte: makeInequality(function (cmpValue) {
    return cmpValue >= 0;
  }),
  $mod: {
    compileElementSelector: function (operand) {
      if (!(isArray(operand) && operand.length === 2
            && typeof(operand[0]) === 'number'
            && typeof(operand[1]) === 'number')) {
        throw Error("argument to $mod must be an array of two numbers");
      }
      // XXX could require to be ints or round or something
      var divisor = operand[0];
      var remainder = operand[1];
      return function (value) {
        return typeof value === 'number' && value % divisor === remainder;
      };
    }
  },
  $in: {
    compileElementSelector: function (operand) {
      if (!isArray(operand))
        throw Error("$in needs an array");

      var elementMatchers = [];
      _.each(operand, function (option) {
        if (option instanceof RegExp)
          elementMatchers.push(regexpElementMatcher(option));
        else if (isOperatorObject(option))
          throw Error("cannot nest $ under $in");
        else
          elementMatchers.push(equalityElementMatcher(option));
      });

      return function (value) {
        // Allow {a: {$in: [null]}} to match when 'a' does not exist.
        if (value === undefined)
          value = null;
        return _.any(elementMatchers, function (e) {
          return e(value);
        });
      };
    }
  },
  $size: {
    // {a: [[5, 5]]} must match {a: {$size: 1}} but not {a: {$size: 2}}, so we
    // don't want to consider the element [5,5] in the leaf array [[5,5]] as a
    // possible value.
    dontExpandLeafArrays: true,
    compileElementSelector: function (operand) {
      if (typeof operand === 'string') {
        // Don't ask me why, but by experimentation, this seems to be what Mongo
        // does.
        operand = 0;
      } else if (typeof operand !== 'number') {
        throw Error("$size needs a number");
      }
      return function (value) {
        return isArray(value) && value.length === operand;
      };
    }
  },
  $type: {
    // {a: [5]} must not match {a: {$type: 4}} (4 means array), but it should
    // match {a: {$type: 1}} (1 means number), and {a: [[5]]} must match {$a:
    // {$type: 4}}. Thus, when we see a leaf array, we *should* expand it but
    // should *not* include it itself.
    dontIncludeLeafArrays: true,
    compileElementSelector: function (operand) {
      if (typeof operand !== 'number')
        throw Error("$type needs a number");
      return function (value) {
        return value !== undefined
          && LocalCollection._f._type(value) === operand;
      };
    }
  },
  $regex: {
    compileElementSelector: function (operand, valueSelector) {
      if (!(typeof operand === 'string' || operand instanceof RegExp))
        throw Error("$regex has to be a string or RegExp");

      var regexp;
      if (valueSelector.$options !== undefined) {
        // Options passed in $options (even the empty string) always overrides
        // options in the RegExp object itself. (See also
        // Meteor.Collection._rewriteSelector.)

        // Be clear that we only support the JS-supported options, not extended
        // ones (eg, Mongo supports x and s). Ideally we would implement x and s
        // by transforming the regexp, but not today...
        if (/[^gim]/.test(valueSelector.$options))
          throw new Error("Only the i, m, and g regexp options are supported");

        var regexSource = operand instanceof RegExp ? operand.source : operand;
        regexp = new RegExp(regexSource, valueSelector.$options);
      } else if (operand instanceof RegExp) {
        regexp = operand;
      } else {
        regexp = new RegExp(operand);
      }
      return regexpElementMatcher(regexp);
    }
  },
  $elemMatch: {
    dontExpandLeafArrays: true,
    compileElementSelector: function (operand, valueSelector, matcher) {
      if (!isPlainObject(operand))
        throw Error("$elemMatch need an object");

      var subMatcher, isDocMatcher;
      if (isOperatorObject(operand, true)) {
        subMatcher = compileValueSelector(operand, matcher);
        isDocMatcher = false;
      } else {
        // This is NOT the same as compileValueSelector(operand), and not just
        // because of the slightly different calling convention.
        // {$elemMatch: {x: 3}} means "an element has a field x:3", not
        // "consists only of a field x:3". Also, regexps and sub-$ are allowed.
        subMatcher = compileDocumentSelector(operand, matcher,
                                             {inElemMatch: true});
        isDocMatcher = true;
      }

      return function (value) {
        if (!isArray(value))
          return false;
        for (var i = 0; i < value.length; ++i) {
          var arrayElement = value[i];
          var arg;
          if (isDocMatcher) {
            // We can only match {$elemMatch: {b: 3}} against objects.
            // (We can also match against arrays, if there's numeric indices,
            // eg {$elemMatch: {'0.b': 3}} or {$elemMatch: {0: 3}}.)
            if (!isPlainObject(arrayElement) && !isArray(arrayElement))
              return false;
            arg = arrayElement;
          } else {
            // dontIterate ensures that {a: {$elemMatch: {$gt: 5}}} matches
            // {a: [8]} but not {a: [[8]]}
            arg = [{value: arrayElement, dontIterate: true}];
          }
          // XXX support $near in $elemMatch by propagating $distance?
          if (subMatcher(arg).result)
            return i;   // specially understood to mean "use as arrayIndices"
        }
        return false;
      };
    }
  }
};

// makeLookupFunction(key) returns a lookup function.
//
// A lookup function takes in a document and returns an array of matching
// branches.  If no arrays are found while looking up the key, this array will
// have exactly one branches (possibly 'undefined', if some segment of the key
// was not found).
//
// If arrays are found in the middle, this can have more than one element, since
// we "branch". When we "branch", if there are more key segments to look up,
// then we only pursue branches that are plain objects (not arrays or scalars).
// This means we can actually end up with no branches!
//
// We do *NOT* branch on arrays that are found at the end (ie, at the last
// dotted member of the key). We just return that array; if you want to
// effectively "branch" over the array's values, post-process the lookup
// function with expandArraysInBranches.
//
// Each branch is an object with keys:
//  - value: the value at the branch
//  - dontIterate: an optional bool; if true, it means that 'value' is an array
//    that expandArraysInBranches should NOT expand. This specifically happens
//    when there is a numeric index in the key, and ensures the
//    perhaps-surprising MongoDB behavior where {'a.0': 5} does NOT
//    match {a: [[5]]}.
//  - arrayIndices: if any array indexing was done during lookup (either due to
//    explicit numeric indices or implicit branching), this will be an array of
//    the array indices used, from outermost to innermost; it is falsey or
//    absent if no array index is used. If an explicit numeric index is used,
//    the index will be followed in arrayIndices by the string 'x'.
//
//    Note: arrayIndices is used for two purposes. First, it is used to
//    implement the '$' modifier feature, which only ever looks at its first
//    element.
//
//    Second, it is used for sort key generation, which needs to be able to tell
//    the difference between different paths. Moreover, it needs to
//    differentiate between explicit and implicit branching, which is why
//    there's the somewhat hacky 'x' entry: this means that explicit and
//    implicit array lookups will have different full arrayIndices paths. (That
//    code only requires that different paths have different arrayIndices; it
//    doesn't actually "parse" arrayIndices. As an alternative, arrayIndices
//    could contain objects with flags like "implicit", but I think that only
//    makes the code surrounding them more complex.)
//
//    (By the way, this field ends up getting passed around a lot without
//    cloning, so never mutate any arrayIndices field/var in this package!)
//
//
// At the top level, you may only pass in a plain object or array.
//
// See the test 'minimongo - lookup' for some examples of what lookup functions
// return.
makeLookupFunction = function (key) {
  var parts = key.split('.');
  var firstPart = parts.length ? parts[0] : '';
  var firstPartIsNumeric = isNumericKey(firstPart);
  var lookupRest;
  if (parts.length > 1) {
    lookupRest = makeLookupFunction(parts.slice(1).join('.'));
  }

  var elideUnnecessaryFields = function (retVal) {
    if (!retVal.dontIterate)
      delete retVal.dontIterate;
    if (retVal.arrayIndices && !retVal.arrayIndices.length)
      delete retVal.arrayIndices;
    return retVal;
  };

  // Doc will always be a plain object or an array.
  // apply an explicit numeric index, an array.
  return function (doc, arrayIndices) {
    if (!arrayIndices)
      arrayIndices = [];

    if (isArray(doc)) {
      // If we're being asked to do an invalid lookup into an array (non-integer
      // or out-of-bounds), return no results (which is different from returning
      // a single undefined result, in that `null` equality checks won't match).
      if (!(firstPartIsNumeric && firstPart < doc.length))
        return [];

      // Remember that we used this array index. Include an 'x' to indicate that
      // the previous index came from being considered as an explicit array
      // index (not branching).
      arrayIndices = arrayIndices.concat(+firstPart, 'x');
    }

    // Do our first lookup.
    var firstLevel = doc[firstPart];

    // If there is no deeper to dig, return what we found.
    //
    // If what we found is an array, most value selectors will choose to treat
    // the elements of the array as matchable values in their own right, but
    // that's done outside of the lookup function. (Exceptions to this are $size
    // and stuff relating to $elemMatch.  eg, {a: {$size: 2}} does not match {a:
    // [[1, 2]]}.)
    //
    // That said, if we just did an *explicit* array lookup (on doc) to find
    // firstLevel, and firstLevel is an array too, we do NOT want value
    // selectors to iterate over it.  eg, {'a.0': 5} does not match {a: [[5]]}.
    // So in that case, we mark the return value as "don't iterate".
    if (!lookupRest) {
      return [elideUnnecessaryFields({
        value: firstLevel,
        dontIterate: isArray(doc) && isArray(firstLevel),
        arrayIndices: arrayIndices})];
    }

    // We need to dig deeper.  But if we can't, because what we've found is not
    // an array or plain object, we're done. If we just did a numeric index into
    // an array, we return nothing here (this is a change in Mongo 2.5 from
    // Mongo 2.4, where {'a.0.b': null} stopped matching {a: [5]}). Otherwise,
    // return a single `undefined` (which can, for example, match via equality
    // with `null`).
    if (!isIndexable(firstLevel)) {
      if (isArray(doc))
        return [];
      return [elideUnnecessaryFields({value: undefined,
                                      arrayIndices: arrayIndices})];
    }

    var result = [];
    var appendToResult = function (more) {
      Array.prototype.push.apply(result, more);
    };

    // Dig deeper: look up the rest of the parts on whatever we've found.
    // (lookupRest is smart enough to not try to do invalid lookups into
    // firstLevel if it's an array.)
    appendToResult(lookupRest(firstLevel, arrayIndices));

    // If we found an array, then in *addition* to potentially treating the next
    // part as a literal integer lookup, we should also "branch": try to look up
    // the rest of the parts on each array element in parallel.
    //
    // In this case, we *only* dig deeper into array elements that are plain
    // objects. (Recall that we only got this far if we have further to dig.)
    // This makes sense: we certainly don't dig deeper into non-indexable
    // objects. And it would be weird to dig into an array: it's simpler to have
    // a rule that explicit integer indexes only apply to an outer array, not to
    // an array you find after a branching search.
    if (isArray(firstLevel)) {
      _.each(firstLevel, function (branch, arrayIndex) {
        if (isPlainObject(branch)) {
          appendToResult(lookupRest(
            branch,
            arrayIndices.concat(arrayIndex)));
        }
      });
    }

    return result;
  };
};
MinimongoTest.makeLookupFunction = makeLookupFunction;

expandArraysInBranches = function (branches, skipTheArrays) {
  var branchesOut = [];
  _.each(branches, function (branch) {
    var thisIsArray = isArray(branch.value);
    // We include the branch itself, *UNLESS* we it's an array that we're going
    // to iterate and we're told to skip arrays.  (That's right, we include some
    // arrays even skipTheArrays is true: these are arrays that were found via
    // explicit numerical indices.)
    if (!(skipTheArrays && thisIsArray && !branch.dontIterate)) {
      branchesOut.push({
        value: branch.value,
        arrayIndices: branch.arrayIndices
      });
    }
    if (thisIsArray && !branch.dontIterate) {
      _.each(branch.value, function (leaf, i) {
        branchesOut.push({
          value: leaf,
          arrayIndices: (branch.arrayIndices || []).concat(i)
        });
      });
    }
  });
  return branchesOut;
};

var nothingMatcher = function (docOrBranchedValues) {
  return {result: false};
};

var everythingMatcher = function (docOrBranchedValues) {
  return {result: true};
};


// NB: We are cheating and using this function to implement "AND" for both
// "document matchers" and "branched matchers". They both return result objects
// but the argument is different: for the former it's a whole doc, whereas for
// the latter it's an array of "branched values".
var andSomeMatchers = function (subMatchers) {
  if (subMatchers.length === 0)
    return everythingMatcher;
  if (subMatchers.length === 1)
    return subMatchers[0];

  return function (docOrBranches) {
    var ret = {};
    ret.result = _.all(subMatchers, function (f) {
      var subResult = f(docOrBranches);
      // Copy a 'distance' number out of the first sub-matcher that has
      // one. Yes, this means that if there are multiple $near fields in a
      // query, something arbitrary happens; this appears to be consistent with
      // Mongo.
      if (subResult.result && subResult.distance !== undefined
          && ret.distance === undefined) {
        ret.distance = subResult.distance;
      }
      // Similarly, propagate arrayIndices from sub-matchers... but to match
      // MongoDB behavior, this time the *last* sub-matcher with arrayIndices
      // wins.
      if (subResult.result && subResult.arrayIndices) {
        ret.arrayIndices = subResult.arrayIndices;
      }
      return subResult.result;
    });

    // If we didn't actually match, forget any extra metadata we came up with.
    if (!ret.result) {
      delete ret.distance;
      delete ret.arrayIndices;
    }
    return ret;
  };
};

var andDocumentMatchers = andSomeMatchers;
var andBranchedMatchers = andSomeMatchers;


// helpers used by compiled selector code
LocalCollection._f = {
  // XXX for _all and _in, consider building 'inquery' at compile time..

  _type: function (v) {
    if (typeof v === "number")
      return 1;
    if (typeof v === "string")
      return 2;
    if (typeof v === "boolean")
      return 8;
    if (isArray(v))
      return 4;
    if (v === null)
      return 10;
    if (v instanceof RegExp)
      // note that typeof(/x/) === "object"
      return 11;
    if (typeof v === "function")
      return 13;
    if (v instanceof Date)
      return 9;
    if (EJSON.isBinary(v))
      return 5;
    if (v instanceof LocalCollection._ObjectID)
      return 7;
    return 3; // object

    // XXX support some/all of these:
    // 14, symbol
    // 15, javascript code with scope
    // 16, 18: 32-bit/64-bit integer
    // 17, timestamp
    // 255, minkey
    // 127, maxkey
  },

  // deep equality test: use for literal document and array matches
  _equal: function (a, b) {
    return EJSON.equals(a, b, {keyOrderSensitive: true});
  },

  // maps a type code to a value that can be used to sort values of
  // different types
  _typeorder: function (t) {
    // http://www.mongodb.org/display/DOCS/What+is+the+Compare+Order+for+BSON+Types
    // XXX what is the correct sort position for Javascript code?
    // ('100' in the matrix below)
    // XXX minkey/maxkey
    return [-1,  // (not a type)
            1,   // number
            2,   // string
            3,   // object
            4,   // array
            5,   // binary
            -1,  // deprecated
            6,   // ObjectID
            7,   // bool
            8,   // Date
            0,   // null
            9,   // RegExp
            -1,  // deprecated
            100, // JS code
            2,   // deprecated (symbol)
            100, // JS code
            1,   // 32-bit int
            8,   // Mongo timestamp
            1    // 64-bit int
           ][t];
  },

  // compare two values of unknown type according to BSON ordering
  // semantics. (as an extension, consider 'undefined' to be less than
  // any other value.) return negative if a is less, positive if b is
  // less, or 0 if equal
  _cmp: function (a, b) {
    if (a === undefined)
      return b === undefined ? 0 : -1;
    if (b === undefined)
      return 1;
    var ta = LocalCollection._f._type(a);
    var tb = LocalCollection._f._type(b);
    var oa = LocalCollection._f._typeorder(ta);
    var ob = LocalCollection._f._typeorder(tb);
    if (oa !== ob)
      return oa < ob ? -1 : 1;
    if (ta !== tb)
      // XXX need to implement this if we implement Symbol or integers, or
      // Timestamp
      throw Error("Missing type coercion logic in _cmp");
    if (ta === 7) { // ObjectID
      // Convert to string.
      ta = tb = 2;
      a = a.toHexString();
      b = b.toHexString();
    }
    if (ta === 9) { // Date
      // Convert to millis.
      ta = tb = 1;
      a = a.getTime();
      b = b.getTime();
    }

    if (ta === 1) // double
      return a - b;
    if (tb === 2) // string
      return a < b ? -1 : (a === b ? 0 : 1);
    if (ta === 3) { // Object
      // this could be much more efficient in the expected case ...
      var to_array = function (obj) {
        var ret = [];
        for (var key in obj) {
          ret.push(key);
          ret.push(obj[key]);
        }
        return ret;
      };
      return LocalCollection._f._cmp(to_array(a), to_array(b));
    }
    if (ta === 4) { // Array
      for (var i = 0; ; i++) {
        if (i === a.length)
          return (i === b.length) ? 0 : -1;
        if (i === b.length)
          return 1;
        var s = LocalCollection._f._cmp(a[i], b[i]);
        if (s !== 0)
          return s;
      }
    }
    if (ta === 5) { // binary
      // Surprisingly, a small binary blob is always less than a large one in
      // Mongo.
      if (a.length !== b.length)
        return a.length - b.length;
      for (i = 0; i < a.length; i++) {
        if (a[i] < b[i])
          return -1;
        if (a[i] > b[i])
          return 1;
      }
      return 0;
    }
    if (ta === 8) { // boolean
      if (a) return b ? 0 : 1;
      return b ? -1 : 0;
    }
    if (ta === 10) // null
      return 0;
    if (ta === 11) // regexp
      throw Error("Sorting not supported on regular expression"); // XXX
    // 13: javascript code
    // 14: symbol
    // 15: javascript code with scope
    // 16: 32-bit integer
    // 17: timestamp
    // 18: 64-bit integer
    // 255: minkey
    // 127: maxkey
    if (ta === 13) // javascript code
      throw Error("Sorting not supported on Javascript code"); // XXX
    throw Error("Unknown type to sort");
  }
};

// Oddball function used by upsert.
LocalCollection._removeDollarOperators = function (selector) {
  var selectorDoc = {};
  for (var k in selector)
    if (k.substr(0, 1) !== '$')
      selectorDoc[k] = selector[k];
  return selectorDoc;
};


}).call(this);






(function () {

                                                                                                      //
// Give a sort spec, which can be in any of these forms:
//   {"key1": 1, "key2": -1}
//   [["key1", "asc"], ["key2", "desc"]]
//   ["key1", ["key2", "desc"]]
//
// (.. with the first form being dependent on the key enumeration
// behavior of your javascript VM, which usually does what you mean in
// this case if the key names don't look like integers ..)
//
// return a function that takes two objects, and returns -1 if the
// first object comes first in order, 1 if the second object comes
// first, or 0 if neither object comes before the other.

Minimongo.Sorter = function (spec, options) {
  var self = this;
  options = options || {};

  self._sortSpecParts = [];

  var addSpecPart = function (path, ascending) {
    if (!path)
      throw Error("sort keys must be non-empty");
    if (path.charAt(0) === '$')
      throw Error("unsupported sort key: " + path);
    self._sortSpecParts.push({
      path: path,
      lookup: makeLookupFunction(path),
      ascending: ascending
    });
  };

  if (spec instanceof Array) {
    for (var i = 0; i < spec.length; i++) {
      if (typeof spec[i] === "string") {
        addSpecPart(spec[i], true);
      } else {
        addSpecPart(spec[i][0], spec[i][1] !== "desc");
      }
    }
  } else if (typeof spec === "object") {
    _.each(spec, function (value, key) {
      addSpecPart(key, value >= 0);
    });
  } else {
    throw Error("Bad sort specification: " + JSON.stringify(spec));
  }

  // To implement affectedByModifier, we piggy-back on top of Matcher's
  // affectedByModifier code; we create a selector that is affected by the same
  // modifiers as this sort order. This is only implemented on the server.
  if (self.affectedByModifier) {
    var selector = {};
    _.each(self._sortSpecParts, function (spec) {
      selector[spec.path] = 1;
    });
    self._selectorForAffectedByModifier = new Minimongo.Matcher(selector);
  }

  self._keyComparator = composeComparators(
    _.map(self._sortSpecParts, function (spec, i) {
      return self._keyFieldComparator(i);
    }));

  // If you specify a matcher for this Sorter, _keyFilter may be set to a
  // function which selects whether or not a given "sort key" (tuple of values
  // for the different sort spec fields) is compatible with the selector.
  self._keyFilter = null;
  options.matcher && self._useWithMatcher(options.matcher);
};

// In addition to these methods, sorter_project.js defines combineIntoProjection
// on the server only.
_.extend(Minimongo.Sorter.prototype, {
  getComparator: function (options) {
    var self = this;

    // If we have no distances, just use the comparator from the source
    // specification (which defaults to "everything is equal".
    if (!options || !options.distances) {
      return self._getBaseComparator();
    }

    var distances = options.distances;

    // Return a comparator which first tries the sort specification, and if that
    // says "it's equal", breaks ties using $near distances.
    return composeComparators([self._getBaseComparator(), function (a, b) {
      if (!distances.has(a._id))
        throw Error("Missing distance for " + a._id);
      if (!distances.has(b._id))
        throw Error("Missing distance for " + b._id);
      return distances.get(a._id) - distances.get(b._id);
    }]);
  },

  _getPaths: function () {
    var self = this;
    return _.pluck(self._sortSpecParts, 'path');
  },

  // Finds the minimum key from the doc, according to the sort specs.  (We say
  // "minimum" here but this is with respect to the sort spec, so "descending"
  // sort fields mean we're finding the max for that field.)
  //
  // Note that this is NOT "find the minimum value of the first field, the
  // minimum value of the second field, etc"... it's "choose the
  // lexicographically minimum value of the key vector, allowing only keys which
  // you can find along the same paths".  ie, for a doc {a: [{x: 0, y: 5}, {x:
  // 1, y: 3}]} with sort spec {'a.x': 1, 'a.y': 1}, the only keys are [0,5] and
  // [1,3], and the minimum key is [0,5]; notably, [0,3] is NOT a key.
  _getMinKeyFromDoc: function (doc) {
    var self = this;
    var minKey = null;

    self._generateKeysFromDoc(doc, function (key) {
      if (!self._keyCompatibleWithSelector(key))
        return;

      if (minKey === null) {
        minKey = key;
        return;
      }
      if (self._compareKeys(key, minKey) < 0) {
        minKey = key;
      }
    });

    // This could happen if our key filter somehow filters out all the keys even
    // though somehow the selector matches.
    if (minKey === null)
      throw Error("sort selector found no keys in doc?");
    return minKey;
  },

  _keyCompatibleWithSelector: function (key) {
    var self = this;
    return !self._keyFilter || self._keyFilter(key);
  },

  // Iterates over each possible "key" from doc (ie, over each branch), calling
  // 'cb' with the key.
  _generateKeysFromDoc: function (doc, cb) {
    var self = this;

    if (self._sortSpecParts.length === 0)
      throw new Error("can't generate keys without a spec");

    // maps index -> ({'' -> value} or {path -> value})
    var valuesByIndexAndPath = [];

    var pathFromIndices = function (indices) {
      return indices.join(',') + ',';
    };

    var knownPaths = null;

    _.each(self._sortSpecParts, function (spec, whichField) {
      // Expand any leaf arrays that we find, and ignore those arrays
      // themselves.  (We never sort based on an array itself.)
      var branches = expandArraysInBranches(spec.lookup(doc), true);

      // If there are no values for a key (eg, key goes to an empty array),
      // pretend we found one null value.
      if (!branches.length)
        branches = [{value: null}];

      var usedPaths = false;
      valuesByIndexAndPath[whichField] = {};
      _.each(branches, function (branch) {
        if (!branch.arrayIndices) {
          // If there are no array indices for a branch, then it must be the
          // only branch, because the only thing that produces multiple branches
          // is the use of arrays.
          if (branches.length > 1)
            throw Error("multiple branches but no array used?");
          valuesByIndexAndPath[whichField][''] = branch.value;
          return;
        }

        usedPaths = true;
        var path = pathFromIndices(branch.arrayIndices);
        if (_.has(valuesByIndexAndPath[whichField], path))
          throw Error("duplicate path: " + path);
        valuesByIndexAndPath[whichField][path] = branch.value;

        // If two sort fields both go into arrays, they have to go into the
        // exact same arrays and we have to find the same paths.  This is
        // roughly the same condition that makes MongoDB throw this strange
        // error message.  eg, the main thing is that if sort spec is {a: 1,
        // b:1} then a and b cannot both be arrays.
        //
        // (In MongoDB it seems to be OK to have {a: 1, 'a.x.y': 1} where 'a'
        // and 'a.x.y' are both arrays, but we don't allow this for now.
        // #NestedArraySort
        // XXX achieve full compatibility here
        if (knownPaths && !_.has(knownPaths, path)) {
          throw Error("cannot index parallel arrays");
        }
      });

      if (knownPaths) {
        // Similarly to above, paths must match everywhere, unless this is a
        // non-array field.
        if (!_.has(valuesByIndexAndPath[whichField], '') &&
            _.size(knownPaths) !== _.size(valuesByIndexAndPath[whichField])) {
          throw Error("cannot index parallel arrays!");
        }
      } else if (usedPaths) {
        knownPaths = {};
        _.each(valuesByIndexAndPath[whichField], function (x, path) {
          knownPaths[path] = true;
        });
      }
    });

    if (!knownPaths) {
      // Easy case: no use of arrays.
      var soleKey = _.map(valuesByIndexAndPath, function (values) {
        if (!_.has(values, ''))
          throw Error("no value in sole key case?");
        return values[''];
      });
      cb(soleKey);
      return;
    }

    _.each(knownPaths, function (x, path) {
      var key = _.map(valuesByIndexAndPath, function (values) {
        if (_.has(values, ''))
          return values[''];
        if (!_.has(values, path))
          throw Error("missing path?");
        return values[path];
      });
      cb(key);
    });
  },

  // Takes in two keys: arrays whose lengths match the number of spec
  // parts. Returns negative, 0, or positive based on using the sort spec to
  // compare fields.
  _compareKeys: function (key1, key2) {
    var self = this;
    if (key1.length !== self._sortSpecParts.length ||
        key2.length !== self._sortSpecParts.length) {
      throw Error("Key has wrong length");
    }

    return self._keyComparator(key1, key2);
  },

  // Given an index 'i', returns a comparator that compares two key arrays based
  // on field 'i'.
  _keyFieldComparator: function (i) {
    var self = this;
    var invert = !self._sortSpecParts[i].ascending;
    return function (key1, key2) {
      var compare = LocalCollection._f._cmp(key1[i], key2[i]);
      if (invert)
        compare = -compare;
      return compare;
    };
  },

  // Returns a comparator that represents the sort specification (but not
  // including a possible geoquery distance tie-breaker).
  _getBaseComparator: function () {
    var self = this;

    // If we're only sorting on geoquery distance and no specs, just say
    // everything is equal.
    if (!self._sortSpecParts.length) {
      return function (doc1, doc2) {
        return 0;
      };
    }

    return function (doc1, doc2) {
      var key1 = self._getMinKeyFromDoc(doc1);
      var key2 = self._getMinKeyFromDoc(doc2);
      return self._compareKeys(key1, key2);
    };
  },

  // In MongoDB, if you have documents
  //    {_id: 'x', a: [1, 10]} and
  //    {_id: 'y', a: [5, 15]},
  // then C.find({}, {sort: {a: 1}}) puts x before y (1 comes before 5).
  // But  C.find({a: {$gt: 3}}, {sort: {a: 1}}) puts y before x (1 does not
  // match the selector, and 5 comes before 10).
  //
  // The way this works is pretty subtle!  For example, if the documents
  // are instead {_id: 'x', a: [{x: 1}, {x: 10}]}) and
  //             {_id: 'y', a: [{x: 5}, {x: 15}]}),
  // then C.find({'a.x': {$gt: 3}}, {sort: {'a.x': 1}}) and
  //      C.find({a: {$elemMatch: {x: {$gt: 3}}}}, {sort: {'a.x': 1}})
  // both follow this rule (y before x).  (ie, you do have to apply this
  // through $elemMatch.)
  //
  // So if you pass a matcher to this sorter's constructor, we will attempt to
  // skip sort keys that don't match the selector. The logic here is pretty
  // subtle and undocumented; we've gotten as close as we can figure out based
  // on our understanding of Mongo's behavior.
  _useWithMatcher: function (matcher) {
    var self = this;

    if (self._keyFilter)
      throw Error("called _useWithMatcher twice?");

    // If we are only sorting by distance, then we're not going to bother to
    // build a key filter.
    // XXX figure out how geoqueries interact with this stuff
    if (_.isEmpty(self._sortSpecParts))
      return;

    var selector = matcher._selector;

    // If the user just passed a literal function to find(), then we can't get a
    // key filter from it.
    if (selector instanceof Function)
      return;

    var constraintsByPath = {};
    _.each(self._sortSpecParts, function (spec, i) {
      constraintsByPath[spec.path] = [];
    });

    _.each(selector, function (subSelector, key) {
      // XXX support $and and $or

      var constraints = constraintsByPath[key];
      if (!constraints)
        return;

      // XXX it looks like the real MongoDB implementation isn't "does the
      // regexp match" but "does the value fall into a range named by the
      // literal prefix of the regexp", ie "foo" in /^foo(bar|baz)+/  But
      // "does the regexp match" is a good approximation.
      if (subSelector instanceof RegExp) {
        // As far as we can tell, using either of the options that both we and
        // MongoDB support ('i' and 'm') disables use of the key filter. This
        // makes sense: MongoDB mostly appears to be calculating ranges of an
        // index to use, which means it only cares about regexps that match
        // one range (with a literal prefix), and both 'i' and 'm' prevent the
        // literal prefix of the regexp from actually meaning one range.
        if (subSelector.ignoreCase || subSelector.multiline)
          return;
        constraints.push(regexpElementMatcher(subSelector));
        return;
      }

      if (isOperatorObject(subSelector)) {
        _.each(subSelector, function (operand, operator) {
          if (_.contains(['$lt', '$lte', '$gt', '$gte'], operator)) {
            // XXX this depends on us knowing that these operators don't use any
            // of the arguments to compileElementSelector other than operand.
            constraints.push(
              ELEMENT_OPERATORS[operator].compileElementSelector(operand));
          }

          // See comments in the RegExp block above.
          if (operator === '$regex' && !subSelector.$options) {
            constraints.push(
              ELEMENT_OPERATORS.$regex.compileElementSelector(
                operand, subSelector));
          }

          // XXX support {$exists: true}, $mod, $type, $in, $elemMatch
        });
        return;
      }

      // OK, it's an equality thing.
      constraints.push(equalityElementMatcher(subSelector));
    });

    // It appears that the first sort field is treated differently from the
    // others; we shouldn't create a key filter unless the first sort field is
    // restricted, though after that point we can restrict the other sort fields
    // or not as we wish.
    if (_.isEmpty(constraintsByPath[self._sortSpecParts[0].path]))
      return;

    self._keyFilter = function (key) {
      return _.all(self._sortSpecParts, function (specPart, index) {
        return _.all(constraintsByPath[specPart.path], function (f) {
          return f(key[index]);
        });
      });
    };
  }
});

// Given an array of comparators
// (functions (a,b)->(negative or positive or zero)), returns a single
// comparator which uses each comparator in order and returns the first
// non-zero value.
var composeComparators = function (comparatorArray) {
  return function (a, b) {
    for (var i = 0; i < comparatorArray.length; ++i) {
      var compare = comparatorArray[i](a, b);
      if (compare !== 0)
        return compare;
    }
    return 0;
  };
};


}).call(this);






(function () {

                                                                                                      //
// Knows how to compile a fields projection to a predicate function.
// @returns - Function: a closure that filters out an object according to the
//            fields projection rules:
//            @param obj - Object: MongoDB-styled document
//            @returns - Object: a document with the fields filtered out
//                       according to projection rules. Doesn't retain subfields
//                       of passed argument.
LocalCollection._compileProjection = function (fields) {
  LocalCollection._checkSupportedProjection(fields);

  var _idProjection = _.isUndefined(fields._id) ? true : fields._id;
  var details = projectionDetails(fields);

  // returns transformed doc according to ruleTree
  var transform = function (doc, ruleTree) {
    // Special case for "sets"
    if (_.isArray(doc))
      return _.map(doc, function (subdoc) { return transform(subdoc, ruleTree); });

    var res = details.including ? {} : EJSON.clone(doc);
    _.each(ruleTree, function (rule, key) {
      if (!_.has(doc, key))
        return;
      if (_.isObject(rule)) {
        // For sub-objects/subsets we branch
        if (_.isObject(doc[key]))
          res[key] = transform(doc[key], rule);
        // Otherwise we don't even touch this subfield
      } else if (details.including)
        res[key] = EJSON.clone(doc[key]);
      else
        delete res[key];
    });

    return res;
  };

  return function (obj) {
    var res = transform(obj, details.tree);

    if (_idProjection && _.has(obj, '_id'))
      res._id = obj._id;
    if (!_idProjection && _.has(res, '_id'))
      delete res._id;
    return res;
  };
};

// Traverses the keys of passed projection and constructs a tree where all
// leaves are either all True or all False
// @returns Object:
//  - tree - Object - tree representation of keys involved in projection
//  (exception for '_id' as it is a special case handled separately)
//  - including - Boolean - "take only certain fields" type of projection
projectionDetails = function (fields) {
  // Find the non-_id keys (_id is handled specially because it is included unless
  // explicitly excluded). Sort the keys, so that our code to detect overlaps
  // like 'foo' and 'foo.bar' can assume that 'foo' comes first.
  var fieldsKeys = _.keys(fields).sort();

  // If there are other rules other than '_id', treat '_id' differently in a
  // separate case. If '_id' is the only rule, use it to understand if it is
  // including/excluding projection.
  if (fieldsKeys.length > 0 && !(fieldsKeys.length === 1 && fieldsKeys[0] === '_id'))
    fieldsKeys = _.reject(fieldsKeys, function (key) { return key === '_id'; });

  var including = null; // Unknown

  _.each(fieldsKeys, function (keyPath) {
    var rule = !!fields[keyPath];
    if (including === null)
      including = rule;
    if (including !== rule)
      // This error message is copies from MongoDB shell
      throw MinimongoError("You cannot currently mix including and excluding fields.");
  });


  var projectionRulesTree = pathsToTree(
    fieldsKeys,
    function (path) { return including; },
    function (node, path, fullPath) {
      // Check passed projection fields' keys: If you have two rules such as
      // 'foo.bar' and 'foo.bar.baz', then the result becomes ambiguous. If
      // that happens, there is a probability you are doing something wrong,
      // framework should notify you about such mistake earlier on cursor
      // compilation step than later during runtime.  Note, that real mongo
      // doesn't do anything about it and the later rule appears in projection
      // project, more priority it takes.
      //
      // Example, assume following in mongo shell:
      // > db.coll.insert({ a: { b: 23, c: 44 } })
      // > db.coll.find({}, { 'a': 1, 'a.b': 1 })
      // { "_id" : ObjectId("520bfe456024608e8ef24af3"), "a" : { "b" : 23 } }
      // > db.coll.find({}, { 'a.b': 1, 'a': 1 })
      // { "_id" : ObjectId("520bfe456024608e8ef24af3"), "a" : { "b" : 23, "c" : 44 } }
      //
      // Note, how second time the return set of keys is different.

      var currentPath = fullPath;
      var anotherPath = path;
      throw MinimongoError("both " + currentPath + " and " + anotherPath +
                           " found in fields option, using both of them may trigger " +
                           "unexpected behavior. Did you mean to use only one of them?");
    });

  return {
    tree: projectionRulesTree,
    including: including
  };
};

// paths - Array: list of mongo style paths
// newLeafFn - Function: of form function(path) should return a scalar value to
//                       put into list created for that path
// conflictFn - Function: of form function(node, path, fullPath) is called
//                        when building a tree path for 'fullPath' node on
//                        'path' was already a leaf with a value. Must return a
//                        conflict resolution.
// initial tree - Optional Object: starting tree.
// @returns - Object: tree represented as a set of nested objects
pathsToTree = function (paths, newLeafFn, conflictFn, tree) {
  tree = tree || {};
  _.each(paths, function (keyPath) {
    var treePos = tree;
    var pathArr = keyPath.split('.');

    // use _.all just for iteration with break
    var success = _.all(pathArr.slice(0, -1), function (key, idx) {
      if (!_.has(treePos, key))
        treePos[key] = {};
      else if (!_.isObject(treePos[key])) {
        treePos[key] = conflictFn(treePos[key],
                                  pathArr.slice(0, idx + 1).join('.'),
                                  keyPath);
        // break out of loop if we are failing for this path
        if (!_.isObject(treePos[key]))
          return false;
      }

      treePos = treePos[key];
      return true;
    });

    if (success) {
      var lastKey = _.last(pathArr);
      if (!_.has(treePos, lastKey))
        treePos[lastKey] = newLeafFn(keyPath);
      else
        treePos[lastKey] = conflictFn(treePos[lastKey], keyPath, keyPath);
    }
  });

  return tree;
};

LocalCollection._checkSupportedProjection = function (fields) {
  if (!_.isObject(fields) || _.isArray(fields))
    throw MinimongoError("fields option must be an object");

  _.each(fields, function (val, keyPath) {
    if (_.contains(keyPath.split('.'), '$'))
      throw MinimongoError("Minimongo doesn't support $ operator in projections yet.");
    if (_.indexOf([1, 0, true, false], val) === -1)
      throw MinimongoError("Projection values should be one of 1, 0, true, or false");
  });
};



}).call(this);






(function () {

                                                                                                      //
// XXX need a strategy for passing the binding of $ into this
// function, from the compiled selector
//
// maybe just {key.up.to.just.before.dollarsign: array_index}
//
// XXX atomicity: if one modification fails, do we roll back the whole
// change?
//
// options:
//   - isInsert is set when _modify is being called to compute the document to
//     insert as part of an upsert operation. We use this primarily to figure
//     out when to set the fields in $setOnInsert, if present.
LocalCollection._modify = function (doc, mod, options) {
  options = options || {};
  if (!isPlainObject(mod))
    throw MinimongoError("Modifier must be an object");
  var isModifier = isOperatorObject(mod);

  var newDoc;

  if (!isModifier) {
    if (mod._id && !EJSON.equals(doc._id, mod._id))
      throw MinimongoError("Cannot change the _id of a document");

    // replace the whole document
    for (var k in mod) {
      if (/\./.test(k))
        throw MinimongoError(
          "When replacing document, field name may not contain '.'");
    }
    newDoc = mod;
  } else {
    // apply modifiers to the doc.
    newDoc = EJSON.clone(doc);

    _.each(mod, function (operand, op) {
      var modFunc = MODIFIERS[op];
      // Treat $setOnInsert as $set if this is an insert.
      if (options.isInsert && op === '$setOnInsert')
        modFunc = MODIFIERS['$set'];
      if (!modFunc)
        throw MinimongoError("Invalid modifier specified " + op);
      _.each(operand, function (arg, keypath) {
        // XXX mongo doesn't allow mod field names to end in a period,
        // but I don't see why.. it allows '' as a key, as does JS
        if (keypath.length && keypath[keypath.length-1] === '.')
          throw MinimongoError(
            "Invalid mod field name, may not end in a period");

        if (keypath === '_id')
          throw MinimongoError("Mod on _id not allowed");

        var keyparts = keypath.split('.');
        var noCreate = _.has(NO_CREATE_MODIFIERS, op);
        var forbidArray = (op === "$rename");
        var target = findModTarget(newDoc, keyparts, {
          noCreate: NO_CREATE_MODIFIERS[op],
          forbidArray: (op === "$rename"),
          arrayIndices: options.arrayIndices
        });
        var field = keyparts.pop();
        modFunc(target, field, arg, keypath, newDoc);
      });
    });
  }

  // move new document into place.
  _.each(_.keys(doc), function (k) {
    // Note: this used to be for (var k in doc) however, this does not
    // work right in Opera. Deleting from a doc while iterating over it
    // would sometimes cause opera to skip some keys.

    // isInsert: if we're constructing a document to insert (via upsert)
    // and we're in replacement mode, not modify mode, DON'T take the
    // _id from the query.  This matches mongo's behavior.
    if (k !== '_id' || options.isInsert)
      delete doc[k];
  });
  _.each(newDoc, function (v, k) {
    doc[k] = v;
  });
};

// for a.b.c.2.d.e, keyparts should be ['a', 'b', 'c', '2', 'd', 'e'],
// and then you would operate on the 'e' property of the returned
// object.
//
// if options.noCreate is falsey, creates intermediate levels of
// structure as necessary, like mkdir -p (and raises an exception if
// that would mean giving a non-numeric property to an array.) if
// options.noCreate is true, return undefined instead.
//
// may modify the last element of keyparts to signal to the caller that it needs
// to use a different value to index into the returned object (for example,
// ['a', '01'] -> ['a', 1]).
//
// if forbidArray is true, return null if the keypath goes through an array.
//
// if options.arrayIndices is set, use its first element for the (first) '$' in
// the path.
var findModTarget = function (doc, keyparts, options) {
  options = options || {};
  var usedArrayIndex = false;
  for (var i = 0; i < keyparts.length; i++) {
    var last = (i === keyparts.length - 1);
    var keypart = keyparts[i];
    var indexable = isIndexable(doc);
    if (!indexable) {
      if (options.noCreate)
        return undefined;
      var e = MinimongoError(
        "cannot use the part '" + keypart + "' to traverse " + doc);
      e.setPropertyError = true;
      throw e;
    }
    if (doc instanceof Array) {
      if (options.forbidArray)
        return null;
      if (keypart === '$') {
        if (usedArrayIndex)
          throw MinimongoError("Too many positional (i.e. '$') elements");
        if (!options.arrayIndices || !options.arrayIndices.length) {
          throw MinimongoError("The positional operator did not find the " +
                               "match needed from the query");
        }
        keypart = options.arrayIndices[0];
        usedArrayIndex = true;
      } else if (isNumericKey(keypart)) {
        keypart = parseInt(keypart);
      } else {
        if (options.noCreate)
          return undefined;
        throw MinimongoError(
          "can't append to array using string field name ["
                    + keypart + "]");
      }
      if (last)
        // handle 'a.01'
        keyparts[i] = keypart;
      if (options.noCreate && keypart >= doc.length)
        return undefined;
      while (doc.length < keypart)
        doc.push(null);
      if (!last) {
        if (doc.length === keypart)
          doc.push({});
        else if (typeof doc[keypart] !== "object")
          throw MinimongoError("can't modify field '" + keyparts[i + 1] +
                      "' of list value " + JSON.stringify(doc[keypart]));
      }
    } else {
      if (keypart.length && keypart.substr(0, 1) === '$')
        throw MinimongoError("can't set field named " + keypart);
      if (!(keypart in doc)) {
        if (options.noCreate)
          return undefined;
        if (!last)
          doc[keypart] = {};
      }
    }

    if (last)
      return doc;
    doc = doc[keypart];
  }

  // notreached
};

var NO_CREATE_MODIFIERS = {
  $unset: true,
  $pop: true,
  $rename: true,
  $pull: true,
  $pullAll: true
};

var MODIFIERS = {
  $inc: function (target, field, arg) {
    if (typeof arg !== "number")
      throw MinimongoError("Modifier $inc allowed for numbers only");
    if (field in target) {
      if (typeof target[field] !== "number")
        throw MinimongoError("Cannot apply $inc modifier to non-number");
      target[field] += arg;
    } else {
      target[field] = arg;
    }
  },
  $set: function (target, field, arg) {
    if (!_.isObject(target)) { // not an array or an object
      var e = MinimongoError("Cannot set property on non-object field");
      e.setPropertyError = true;
      throw e;
    }
    if (target === null) {
      var e = MinimongoError("Cannot set property on null");
      e.setPropertyError = true;
      throw e;
    }
    target[field] = EJSON.clone(arg);
  },
  $setOnInsert: function (target, field, arg) {
    // converted to `$set` in `_modify`
  },
  $unset: function (target, field, arg) {
    if (target !== undefined) {
      if (target instanceof Array) {
        if (field in target)
          target[field] = null;
      } else
        delete target[field];
    }
  },
  $push: function (target, field, arg) {
    if (target[field] === undefined)
      target[field] = [];
    if (!(target[field] instanceof Array))
      throw MinimongoError("Cannot apply $push modifier to non-array");

    if (!(arg && arg.$each)) {
      // Simple mode: not $each
      target[field].push(EJSON.clone(arg));
      return;
    }

    // Fancy mode: $each (and maybe $slice and $sort)
    var toPush = arg.$each;
    if (!(toPush instanceof Array))
      throw MinimongoError("$each must be an array");

    // Parse $slice.
    var slice = undefined;
    if ('$slice' in arg) {
      if (typeof arg.$slice !== "number")
        throw MinimongoError("$slice must be a numeric value");
      // XXX should check to make sure integer
      if (arg.$slice > 0)
        throw MinimongoError("$slice in $push must be zero or negative");
      slice = arg.$slice;
    }

    // Parse $sort.
    var sortFunction = undefined;
    if (arg.$sort) {
      if (slice === undefined)
        throw MinimongoError("$sort requires $slice to be present");
      // XXX this allows us to use a $sort whose value is an array, but that's
      // actually an extension of the Node driver, so it won't work
      // server-side. Could be confusing!
      // XXX is it correct that we don't do geo-stuff here?
      sortFunction = new Minimongo.Sorter(arg.$sort).getComparator();
      for (var i = 0; i < toPush.length; i++) {
        if (LocalCollection._f._type(toPush[i]) !== 3) {
          throw MinimongoError("$push like modifiers using $sort " +
                      "require all elements to be objects");
        }
      }
    }

    // Actually push.
    for (var j = 0; j < toPush.length; j++)
      target[field].push(EJSON.clone(toPush[j]));

    // Actually sort.
    if (sortFunction)
      target[field].sort(sortFunction);

    // Actually slice.
    if (slice !== undefined) {
      if (slice === 0)
        target[field] = [];  // differs from Array.slice!
      else
        target[field] = target[field].slice(slice);
    }
  },
  $pushAll: function (target, field, arg) {
    if (!(typeof arg === "object" && arg instanceof Array))
      throw MinimongoError("Modifier $pushAll/pullAll allowed for arrays only");
    var x = target[field];
    if (x === undefined)
      target[field] = arg;
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $pushAll modifier to non-array");
    else {
      for (var i = 0; i < arg.length; i++)
        x.push(arg[i]);
    }
  },
  $addToSet: function (target, field, arg) {
    var x = target[field];
    if (x === undefined)
      target[field] = [arg];
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $addToSet modifier to non-array");
    else {
      var isEach = false;
      if (typeof arg === "object") {
        for (var k in arg) {
          if (k === "$each")
            isEach = true;
          break;
        }
      }
      var values = isEach ? arg["$each"] : [arg];
      _.each(values, function (value) {
        for (var i = 0; i < x.length; i++)
          if (LocalCollection._f._equal(value, x[i]))
            return;
        x.push(EJSON.clone(value));
      });
    }
  },
  $pop: function (target, field, arg) {
    if (target === undefined)
      return;
    var x = target[field];
    if (x === undefined)
      return;
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $pop modifier to non-array");
    else {
      if (typeof arg === 'number' && arg < 0)
        x.splice(0, 1);
      else
        x.pop();
    }
  },
  $pull: function (target, field, arg) {
    if (target === undefined)
      return;
    var x = target[field];
    if (x === undefined)
      return;
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $pull/pullAll modifier to non-array");
    else {
      var out = [];
      if (typeof arg === "object" && !(arg instanceof Array)) {
        // XXX would be much nicer to compile this once, rather than
        // for each document we modify.. but usually we're not
        // modifying that many documents, so we'll let it slide for
        // now

        // XXX Minimongo.Matcher isn't up for the job, because we need
        // to permit stuff like {$pull: {a: {$gt: 4}}}.. something
        // like {$gt: 4} is not normally a complete selector.
        // same issue as $elemMatch possibly?
        var matcher = new Minimongo.Matcher(arg);
        for (var i = 0; i < x.length; i++)
          if (!matcher.documentMatches(x[i]).result)
            out.push(x[i]);
      } else {
        for (var i = 0; i < x.length; i++)
          if (!LocalCollection._f._equal(x[i], arg))
            out.push(x[i]);
      }
      target[field] = out;
    }
  },
  $pullAll: function (target, field, arg) {
    if (!(typeof arg === "object" && arg instanceof Array))
      throw MinimongoError("Modifier $pushAll/pullAll allowed for arrays only");
    if (target === undefined)
      return;
    var x = target[field];
    if (x === undefined)
      return;
    else if (!(x instanceof Array))
      throw MinimongoError("Cannot apply $pull/pullAll modifier to non-array");
    else {
      var out = [];
      for (var i = 0; i < x.length; i++) {
        var exclude = false;
        for (var j = 0; j < arg.length; j++) {
          if (LocalCollection._f._equal(x[i], arg[j])) {
            exclude = true;
            break;
          }
        }
        if (!exclude)
          out.push(x[i]);
      }
      target[field] = out;
    }
  },
  $rename: function (target, field, arg, keypath, doc) {
    if (keypath === arg)
      // no idea why mongo has this restriction..
      throw MinimongoError("$rename source must differ from target");
    if (target === null)
      throw MinimongoError("$rename source field invalid");
    if (typeof arg !== "string")
      throw MinimongoError("$rename target must be a string");
    if (target === undefined)
      return;
    var v = target[field];
    delete target[field];

    var keyparts = arg.split('.');
    var target2 = findModTarget(doc, keyparts, {forbidArray: true});
    if (target2 === null)
      throw MinimongoError("$rename target field invalid");
    var field2 = keyparts.pop();
    target2[field2] = v;
  },
  $bit: function (target, field, arg) {
    // XXX mongo only supports $bit on integers, and we only support
    // native javascript numbers (doubles) so far, so we can't support $bit
    throw MinimongoError("$bit is not supported");
  }
};


}).call(this);






(function () {

                                                                                                      //

// ordered: bool.
// old_results and new_results: collections of documents.
//    if ordered, they are arrays.
//    if unordered, they are IdMaps
LocalCollection._diffQueryChanges = function (ordered, oldResults, newResults,
                                       observer) {
  if (ordered)
    LocalCollection._diffQueryOrderedChanges(
      oldResults, newResults, observer);
  else
    LocalCollection._diffQueryUnorderedChanges(
      oldResults, newResults, observer);
};

LocalCollection._diffQueryUnorderedChanges = function (oldResults, newResults,
                                                       observer) {
  if (observer.movedBefore) {
    throw new Error("_diffQueryUnordered called with a movedBefore observer!");
  }

  newResults.forEach(function (newDoc, id) {
    var oldDoc = oldResults.get(id);
    if (oldDoc) {
      if (observer.changed && !EJSON.equals(oldDoc, newDoc)) {
        observer.changed(
          id, LocalCollection._makeChangedFields(newDoc, oldDoc));
      }
    } else if (observer.added) {
      var fields = EJSON.clone(newDoc);
      delete fields._id;
      observer.added(newDoc._id, fields);
    }
  });

  if (observer.removed) {
    oldResults.forEach(function (oldDoc, id) {
      if (!newResults.has(id))
        observer.removed(id);
    });
  }
};


LocalCollection._diffQueryOrderedChanges = function (old_results, new_results, observer) {

  var new_presence_of_id = {};
  _.each(new_results, function (doc) {
    if (new_presence_of_id[doc._id])
      Meteor._debug("Duplicate _id in new_results");
    new_presence_of_id[doc._id] = true;
  });

  var old_index_of_id = {};
  _.each(old_results, function (doc, i) {
    if (doc._id in old_index_of_id)
      Meteor._debug("Duplicate _id in old_results");
    old_index_of_id[doc._id] = i;
  });

  // ALGORITHM:
  //
  // To determine which docs should be considered "moved" (and which
  // merely change position because of other docs moving) we run
  // a "longest common subsequence" (LCS) algorithm.  The LCS of the
  // old doc IDs and the new doc IDs gives the docs that should NOT be
  // considered moved.

  // To actually call the appropriate callbacks to get from the old state to the
  // new state:

  // First, we call removed() on all the items that only appear in the old
  // state.

  // Then, once we have the items that should not move, we walk through the new
  // results array group-by-group, where a "group" is a set of items that have
  // moved, anchored on the end by an item that should not move.  One by one, we
  // move each of those elements into place "before" the anchoring end-of-group
  // item, and fire changed events on them if necessary.  Then we fire a changed
  // event on the anchor, and move on to the next group.  There is always at
  // least one group; the last group is anchored by a virtual "null" id at the
  // end.

  // Asymptotically: O(N k) where k is number of ops, or potentially
  // O(N log N) if inner loop of LCS were made to be binary search.


  //////// LCS (longest common sequence, with respect to _id)
  // (see Wikipedia article on Longest Increasing Subsequence,
  // where the LIS is taken of the sequence of old indices of the
  // docs in new_results)
  //
  // unmoved: the output of the algorithm; members of the LCS,
  // in the form of indices into new_results
  var unmoved = [];
  // max_seq_len: length of LCS found so far
  var max_seq_len = 0;
  // seq_ends[i]: the index into new_results of the last doc in a
  // common subsequence of length of i+1 <= max_seq_len
  var N = new_results.length;
  var seq_ends = new Array(N);
  // ptrs:  the common subsequence ending with new_results[n] extends
  // a common subsequence ending with new_results[ptr[n]], unless
  // ptr[n] is -1.
  var ptrs = new Array(N);
  // virtual sequence of old indices of new results
  var old_idx_seq = function(i_new) {
    return old_index_of_id[new_results[i_new]._id];
  };
  // for each item in new_results, use it to extend a common subsequence
  // of length j <= max_seq_len
  for(var i=0; i<N; i++) {
    if (old_index_of_id[new_results[i]._id] !== undefined) {
      var j = max_seq_len;
      // this inner loop would traditionally be a binary search,
      // but scanning backwards we will likely find a subseq to extend
      // pretty soon, bounded for example by the total number of ops.
      // If this were to be changed to a binary search, we'd still want
      // to scan backwards a bit as an optimization.
      while (j > 0) {
        if (old_idx_seq(seq_ends[j-1]) < old_idx_seq(i))
          break;
        j--;
      }

      ptrs[i] = (j === 0 ? -1 : seq_ends[j-1]);
      seq_ends[j] = i;
      if (j+1 > max_seq_len)
        max_seq_len = j+1;
    }
  }

  // pull out the LCS/LIS into unmoved
  var idx = (max_seq_len === 0 ? -1 : seq_ends[max_seq_len-1]);
  while (idx >= 0) {
    unmoved.push(idx);
    idx = ptrs[idx];
  }
  // the unmoved item list is built backwards, so fix that
  unmoved.reverse();

  // the last group is always anchored by the end of the result list, which is
  // an id of "null"
  unmoved.push(new_results.length);

  _.each(old_results, function (doc) {
    if (!new_presence_of_id[doc._id])
      observer.removed && observer.removed(doc._id);
  });
  // for each group of things in the new_results that is anchored by an unmoved
  // element, iterate through the things before it.
  var startOfGroup = 0;
  _.each(unmoved, function (endOfGroup) {
    var groupId = new_results[endOfGroup] ? new_results[endOfGroup]._id : null;
    var oldDoc;
    var newDoc;
    var fields;
    for (var i = startOfGroup; i < endOfGroup; i++) {
      newDoc = new_results[i];
      if (!_.has(old_index_of_id, newDoc._id)) {
        fields = EJSON.clone(newDoc);
        delete fields._id;
        observer.addedBefore && observer.addedBefore(newDoc._id, fields, groupId);
        observer.added && observer.added(newDoc._id, fields);
      } else {
        // moved
        oldDoc = old_results[old_index_of_id[newDoc._id]];
        fields = LocalCollection._makeChangedFields(newDoc, oldDoc);
        if (!_.isEmpty(fields)) {
          observer.changed && observer.changed(newDoc._id, fields);
        }
        observer.movedBefore && observer.movedBefore(newDoc._id, groupId);
      }
    }
    if (groupId) {
      newDoc = new_results[endOfGroup];
      oldDoc = old_results[old_index_of_id[newDoc._id]];
      fields = LocalCollection._makeChangedFields(newDoc, oldDoc);
      if (!_.isEmpty(fields)) {
        observer.changed && observer.changed(newDoc._id, fields);
      }
    }
    startOfGroup = endOfGroup+1;
  });


};


// General helper for diff-ing two objects.
// callbacks is an object like so:
// { leftOnly: function (key, leftValue) {...},
//   rightOnly: function (key, rightValue) {...},
//   both: function (key, leftValue, rightValue) {...},
// }
LocalCollection._diffObjects = function (left, right, callbacks) {
  _.each(left, function (leftValue, key) {
    if (_.has(right, key))
      callbacks.both && callbacks.both(key, leftValue, right[key]);
    else
      callbacks.leftOnly && callbacks.leftOnly(key, leftValue);
  });
  if (callbacks.rightOnly) {
    _.each(right, function(rightValue, key) {
      if (!_.has(left, key))
        callbacks.rightOnly(key, rightValue);
    });
  }
};


}).call(this);






(function () {

                                                                                                      //
LocalCollection._IdMap = function () {
  var self = this;
  IdMap.call(self, LocalCollection._idStringify, LocalCollection._idParse);
};

Meteor._inherits(LocalCollection._IdMap, IdMap);



}).call(this);






(function () {

                                                                                                      //
// XXX maybe move these into another ObserveHelpers package or something

// _CachingChangeObserver is an object which receives observeChanges callbacks
// and keeps a cache of the current cursor state up to date in self.docs. Users
// of this class should read the docs field but not modify it. You should pass
// the "applyChange" field as the callbacks to the underlying observeChanges
// call. Optionally, you can specify your own observeChanges callbacks which are
// invoked immediately before the docs field is updated; this object is made
// available as `this` to those callbacks.
LocalCollection._CachingChangeObserver = function (options) {
  var self = this;
  options = options || {};

  var orderedFromCallbacks = options.callbacks &&
        LocalCollection._observeChangesCallbacksAreOrdered(options.callbacks);
  if (_.has(options, 'ordered')) {
    self.ordered = options.ordered;
    if (options.callbacks && options.ordered !== orderedFromCallbacks)
      throw Error("ordered option doesn't match callbacks");
  } else if (options.callbacks) {
    self.ordered = orderedFromCallbacks;
  } else {
    throw Error("must provide ordered or callbacks");
  }
  var callbacks = options.callbacks || {};

  if (self.ordered) {
    self.docs = new OrderedDict(LocalCollection._idStringify);
    self.applyChange = {
      addedBefore: function (id, fields, before) {
        var doc = EJSON.clone(fields);
        doc._id = id;
        callbacks.addedBefore && callbacks.addedBefore.call(
          self, id, fields, before);
        // This line triggers if we provide added with movedBefore.
        callbacks.added && callbacks.added.call(self, id, fields);
        // XXX could `before` be a falsy ID?  Technically
        // idStringify seems to allow for them -- though
        // OrderedDict won't call stringify on a falsy arg.
        self.docs.putBefore(id, doc, before || null);
      },
      movedBefore: function (id, before) {
        var doc = self.docs.get(id);
        callbacks.movedBefore && callbacks.movedBefore.call(self, id, before);
        self.docs.moveBefore(id, before || null);
      }
    };
  } else {
    self.docs = new LocalCollection._IdMap;
    self.applyChange = {
      added: function (id, fields) {
        var doc = EJSON.clone(fields);
        callbacks.added && callbacks.added.call(self, id, fields);
        doc._id = id;
        self.docs.set(id,  doc);
      }
    };
  }

  // The methods in _IdMap and OrderedDict used by these callbacks are
  // identical.
  self.applyChange.changed = function (id, fields) {
    var doc = self.docs.get(id);
    if (!doc)
      throw new Error("Unknown id for changed: " + id);
    callbacks.changed && callbacks.changed.call(
      self, id, EJSON.clone(fields));
    LocalCollection._applyChanges(doc, fields);
  };
  self.applyChange.removed = function (id) {
    callbacks.removed && callbacks.removed.call(self, id);
    self.docs.remove(id);
  };
};

LocalCollection._observeFromObserveChanges = function (cursor, observeCallbacks) {
  var transform = cursor.getTransform() || function (doc) {return doc;};
  var suppressed = !!observeCallbacks._suppress_initial;

  var observeChangesCallbacks;
  if (LocalCollection._observeCallbacksAreOrdered(observeCallbacks)) {
    // The "_no_indices" option sets all index arguments to -1 and skips the
    // linear scans required to generate them.  This lets observers that don't
    // need absolute indices benefit from the other features of this API --
    // relative order, transforms, and applyChanges -- without the speed hit.
    var indices = !observeCallbacks._no_indices;
    observeChangesCallbacks = {
      addedBefore: function (id, fields, before) {
        var self = this;
        if (suppressed || !(observeCallbacks.addedAt || observeCallbacks.added))
          return;
        var doc = transform(_.extend(fields, {_id: id}));
        if (observeCallbacks.addedAt) {
          var index = indices
                ? (before ? self.docs.indexOf(before) : self.docs.size()) : -1;
          observeCallbacks.addedAt(doc, index, before);
        } else {
          observeCallbacks.added(doc);
        }
      },
      changed: function (id, fields) {
        var self = this;
        if (!(observeCallbacks.changedAt || observeCallbacks.changed))
          return;
        var doc = EJSON.clone(self.docs.get(id));
        if (!doc)
          throw new Error("Unknown id for changed: " + id);
        var oldDoc = transform(EJSON.clone(doc));
        LocalCollection._applyChanges(doc, fields);
        doc = transform(doc);
        if (observeCallbacks.changedAt) {
          var index = indices ? self.docs.indexOf(id) : -1;
          observeCallbacks.changedAt(doc, oldDoc, index);
        } else {
          observeCallbacks.changed(doc, oldDoc);
        }
      },
      movedBefore: function (id, before) {
        var self = this;
        if (!observeCallbacks.movedTo)
          return;
        var from = indices ? self.docs.indexOf(id) : -1;

        var to = indices
              ? (before ? self.docs.indexOf(before) : self.docs.size()) : -1;
        // When not moving backwards, adjust for the fact that removing the
        // document slides everything back one slot.
        if (to > from)
          --to;
        observeCallbacks.movedTo(transform(EJSON.clone(self.docs.get(id))),
                                 from, to, before || null);
      },
      removed: function (id) {
        var self = this;
        if (!(observeCallbacks.removedAt || observeCallbacks.removed))
          return;
        // technically maybe there should be an EJSON.clone here, but it's about
        // to be removed from self.docs!
        var doc = transform(self.docs.get(id));
        if (observeCallbacks.removedAt) {
          var index = indices ? self.docs.indexOf(id) : -1;
          observeCallbacks.removedAt(doc, index);
        } else {
          observeCallbacks.removed(doc);
        }
      }
    };
  } else {
    observeChangesCallbacks = {
      added: function (id, fields) {
        if (!suppressed && observeCallbacks.added) {
          var doc = _.extend(fields, {_id:  id});
          observeCallbacks.added(transform(doc));
        }
      },
      changed: function (id, fields) {
        var self = this;
        if (observeCallbacks.changed) {
          var oldDoc = self.docs.get(id);
          var doc = EJSON.clone(oldDoc);
          LocalCollection._applyChanges(doc, fields);
          observeCallbacks.changed(transform(doc), transform(oldDoc));
        }
      },
      removed: function (id) {
        var self = this;
        if (observeCallbacks.removed) {
          observeCallbacks.removed(transform(self.docs.get(id)));
        }
      }
    };
  }

  var changeObserver = new LocalCollection._CachingChangeObserver(
    {callbacks: observeChangesCallbacks});
  var handle = cursor.observeChanges(changeObserver.applyChange);
  suppressed = false;

  if (changeObserver.ordered) {
    // Fetches the current list of documents, in order, as an array.  Can be
    // called at any time.  Internal API assumed by the `observe-sequence`
    // package (used by Meteor UI for `#each` blocks).  Only defined on ordered
    // observes (those that listen on `addedAt` or similar).  Continues to work
    // after `stop()` is called on the handle.
    //
    // Because we already materialize the full OrderedDict of all documents, it
    // seems nice to provide access to the view rather than making the data
    // consumer reconstitute it.  This gives the consumer a shot at doing
    // something smart with the feed like proxying it, since firing callbacks
    // like `changed` and `movedTo` basically requires omniscience (knowing old
    // and new documents, old and new indices, and the correct value for
    // `before`).
    //
    // NOTE: If called from an observe callback for a certain change, the result
    // is *not* guaranteed to be a snapshot of the cursor up to that
    // change. This is because the callbacks are invoked before updating docs.
    handle._fetch = function () {
      var docsArray = [];
      changeObserver.docs.forEach(function (doc) {
        docsArray.push(transform(EJSON.clone(doc)));
      });
      return docsArray;
    };
  }

  return handle;
};


}).call(this);






(function () {

                                                                                                      //
LocalCollection._looksLikeObjectID = function (str) {
  return str.length === 24 && str.match(/^[0-9a-f]*$/);
};

LocalCollection._ObjectID = function (hexString) {
  //random-based impl of Mongo ObjectID
  var self = this;
  if (hexString) {
    hexString = hexString.toLowerCase();
    if (!LocalCollection._looksLikeObjectID(hexString)) {
      throw new Error("Invalid hexadecimal string for creating an ObjectID");
    }
    // meant to work with _.isEqual(), which relies on structural equality
    self._str = hexString;
  } else {
    self._str = Random.hexString(24);
  }
};

LocalCollection._ObjectID.prototype.toString = function () {
  var self = this;
  return "ObjectID(\"" + self._str + "\")";
};

LocalCollection._ObjectID.prototype.equals = function (other) {
  var self = this;
  return other instanceof LocalCollection._ObjectID &&
    self.valueOf() === other.valueOf();
};

LocalCollection._ObjectID.prototype.clone = function () {
  var self = this;
  return new LocalCollection._ObjectID(self._str);
};

LocalCollection._ObjectID.prototype.typeName = function() {
  return "oid";
};

LocalCollection._ObjectID.prototype.getTimestamp = function() {
  var self = this;
  return parseInt(self._str.substr(0, 8), 16);
};

LocalCollection._ObjectID.prototype.valueOf =
    LocalCollection._ObjectID.prototype.toJSONValue =
    LocalCollection._ObjectID.prototype.toHexString =
    function () { return this._str; };

// Is this selector just shorthand for lookup by _id?
LocalCollection._selectorIsId = function (selector) {
  return (typeof selector === "string") ||
    (typeof selector === "number") ||
    selector instanceof LocalCollection._ObjectID;
};

// Is the selector just lookup by _id (shorthand or not)?
LocalCollection._selectorIsIdPerhapsAsObject = function (selector) {
  return LocalCollection._selectorIsId(selector) ||
    (selector && typeof selector === "object" &&
     selector._id && LocalCollection._selectorIsId(selector._id) &&
     _.size(selector) === 1);
};

// If this is a selector which explicitly constrains the match by ID to a finite
// number of documents, returns a list of their IDs.  Otherwise returns
// null. Note that the selector may have other restrictions so it may not even
// match those document!  We care about $in and $and since those are generated
// access-controlled update and remove.
LocalCollection._idsMatchedBySelector = function (selector) {
  // Is the selector just an ID?
  if (LocalCollection._selectorIsId(selector))
    return [selector];
  if (!selector)
    return null;

  // Do we have an _id clause?
  if (_.has(selector, '_id')) {
    // Is the _id clause just an ID?
    if (LocalCollection._selectorIsId(selector._id))
      return [selector._id];
    // Is the _id clause {_id: {$in: ["x", "y", "z"]}}?
    if (selector._id && selector._id.$in
        && _.isArray(selector._id.$in)
        && !_.isEmpty(selector._id.$in)
        && _.all(selector._id.$in, LocalCollection._selectorIsId)) {
      return selector._id.$in;
    }
    return null;
  }

  // If this is a top-level $and, and any of the clauses constrain their
  // documents, then the whole selector is constrained by any one clause's
  // constraint. (Well, by their intersection, but that seems unlikely.)
  if (selector.$and && _.isArray(selector.$and)) {
    for (var i = 0; i < selector.$and.length; ++i) {
      var subIds = LocalCollection._idsMatchedBySelector(selector.$and[i]);
      if (subIds)
        return subIds;
    }
  }

  return null;
};

EJSON.addType("oid",  function (str) {
  return new LocalCollection._ObjectID(str);
});


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.minimongo = {
  LocalCollection: LocalCollection,
  Minimongo: Minimongo,
  MinimongoTest: MinimongoTest
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var Deps = Package.deps.Deps;
var LocalCollection = Package.minimongo.LocalCollection;
var Minimongo = Package.minimongo.Minimongo;
var _ = Package.underscore._;
var Random = Package.random.Random;

/* Package-scope variables */
var ObserveSequence;

(function () {

                                                                                        //
var warn = function () {
  if (ObserveSequence._suppressWarnings) {
    ObserveSequence._suppressWarnings--;
  } else {
    if (typeof console !== 'undefined' && console.warn)
      console.warn.apply(console, arguments);

    ObserveSequence._loggedWarnings++;
  }
};

var idStringify = LocalCollection._idStringify;
var idParse = LocalCollection._idParse;

ObserveSequence = {
  _suppressWarnings: 0,
  _loggedWarnings: 0,

  // A mechanism similar to cursor.observe which receives a reactive
  // function returning a sequence type and firing appropriate callbacks
  // when the value changes.
  //
  // @param sequenceFunc {Function} a reactive function returning a
  //     sequence type. The currently supported sequence types are:
  //     'null', arrays and cursors.
  //
  // @param callbacks {Object} similar to a specific subset of
  //     callbacks passed to `cursor.observe`
  //     (http://docs.meteor.com/#observe), with minor variations to
  //     support the fact that not all sequences contain objects with
  //     _id fields.  Specifically:
  //
  //     * addedAt(id, item, atIndex, beforeId)
  //     * changedAt(id, newItem, oldItem, atIndex)
  //     * removedAt(id, oldItem, atIndex)
  //     * movedTo(id, item, fromIndex, toIndex, beforeId)
  //
  // @returns {Object(stop: Function)} call 'stop' on the return value
  //     to stop observing this sequence function.
  //
  // We don't make any assumptions about our ability to compare sequence
  // elements (ie, we don't assume EJSON.equals works; maybe there is extra
  // state/random methods on the objects) so unlike cursor.observe, we may
  // sometimes call changedAt() when nothing actually changed.
  // XXX consider if we *can* make the stronger assumption and avoid
  //     no-op changedAt calls (in some cases?)
  //
  // XXX currently only supports the callbacks used by our
  // implementation of {{#each}}, but this can be expanded.
  //
  // XXX #each doesn't use the indices (though we'll eventually need
  // a way to get them when we support `@index`), but calling
  // `cursor.observe` causes the index to be calculated on every
  // callback using a linear scan (unless you turn it off by passing
  // `_no_indices`).  Any way to avoid calculating indices on a pure
  // cursor observe like we used to?
  observe: function (sequenceFunc, callbacks) {
    var lastSeq = null;
    var activeObserveHandle = null;

    // 'lastSeqArray' contains the previous value of the sequence
    // we're observing. It is an array of objects with '_id' and
    // 'item' fields.  'item' is the element in the array, or the
    // document in the cursor.
    //
    // '_id' is whichever of the following is relevant, unless it has
    // already appeared -- in which case it's randomly generated.
    //
    // * if 'item' is an object:
    //   * an '_id' field, if present
    //   * otherwise, the index in the array
    //
    // * if 'item' is a number or string, use that value
    //
    // XXX this can be generalized by allowing {{#each}} to accept a
    // general 'key' argument which could be a function, a dotted
    // field name, or the special @index value.
    var lastSeqArray = []; // elements are objects of form {_id, item}
    var computation = Deps.autorun(function () {
      var seq = sequenceFunc();

      Deps.nonreactive(function () {
        var seqArray; // same structure as `lastSeqArray` above.

        // If we were previously observing a cursor, replace lastSeqArray with
        // more up-to-date information (specifically, the state of the observe
        // before it was stopped, which may be older than the DB).
        if (activeObserveHandle) {
          lastSeqArray = _.map(activeObserveHandle._fetch(), function (doc) {
            return {_id: doc._id, item: doc};
          });
          activeObserveHandle.stop();
          activeObserveHandle = null;
        }

        if (!seq) {
          seqArray = [];
          diffArray(lastSeqArray, seqArray, callbacks);
        } else if (seq instanceof Array) {
          var idsUsed = {};
          seqArray = _.map(seq, function (item, index) {
            var id;
            if (typeof item === 'string') {
              // ensure not empty, since other layers (eg DomRange) assume this as well
              id = "-" + item;
            } else if (typeof item === 'number' ||
                       typeof item === 'boolean' ||
                       item === undefined) {
              id = item;
            } else if (typeof item === 'object') {
              id = (item && item._id) || index;
            } else {
              throw new Error("{{#each}} doesn't support arrays with " +
                              "elements of type " + typeof item);
            }

            var idString = idStringify(id);
            if (idsUsed[idString]) {
              warn("duplicate id " + id + " in", seq);
              id = Random.id();
            } else {
              idsUsed[idString] = true;
            }

            return { _id: id, item: item };
          });

          diffArray(lastSeqArray, seqArray, callbacks);
        } else if (isMinimongoCursor(seq)) {
          var cursor = seq;
          seqArray = [];

          var initial = true; // are we observing initial data from cursor?
          activeObserveHandle = cursor.observe({
            addedAt: function (document, atIndex, before) {
              if (initial) {
                // keep track of initial data so that we can diff once
                // we exit `observe`.
                if (before !== null)
                  throw new Error("Expected initial data from observe in order");
                seqArray.push({ _id: document._id, item: document });
              } else {
                callbacks.addedAt(document._id, document, atIndex, before);
              }
            },
            changedAt: function (newDocument, oldDocument, atIndex) {
              callbacks.changedAt(newDocument._id, newDocument, oldDocument,
                                  atIndex);
            },
            removedAt: function (oldDocument, atIndex) {
              callbacks.removedAt(oldDocument._id, oldDocument, atIndex);
            },
            movedTo: function (document, fromIndex, toIndex, before) {
              callbacks.movedTo(
                document._id, document, fromIndex, toIndex, before);
            }
          });
          initial = false;

          // diff the old sequnce with initial data in the new cursor. this will
          // fire `addedAt` callbacks on the initial data.
          diffArray(lastSeqArray, seqArray, callbacks);

        } else {
          throw badSequenceError();
        }

        lastSeq = seq;
        lastSeqArray = seqArray;
      });
    });

    return {
      stop: function () {
        computation.stop();
        if (activeObserveHandle)
          activeObserveHandle.stop();
      }
    };
  },

  // Fetch the items of `seq` into an array, where `seq` is of one of the
  // sequence types accepted by `observe`.  If `seq` is a cursor, a
  // dependency is established.
  fetch: function (seq) {
    if (!seq) {
      return [];
    } else if (seq instanceof Array) {
      return seq;
    } else if (isMinimongoCursor(seq)) {
      return seq.fetch();
    } else {
      throw badSequenceError();
    }
  }
};

var badSequenceError = function () {
  return new Error("{{#each}} currently only accepts " +
                   "arrays, cursors or falsey values.");
};

var isMinimongoCursor = function (seq) {
  var minimongo = Package.minimongo;
  return !!minimongo && (seq instanceof minimongo.LocalCollection.Cursor);
};

// Calculates the differences between `lastSeqArray` and
// `seqArray` and calls appropriate functions from `callbacks`.
// Reuses Minimongo's diff algorithm implementation.
var diffArray = function (lastSeqArray, seqArray, callbacks) {
  var diffFn = Package.minimongo.LocalCollection._diffQueryOrderedChanges;
  var oldIdObjects = [];
  var newIdObjects = [];
  var posOld = {}; // maps from idStringify'd ids
  var posNew = {}; // ditto
  var posCur = {};
  var lengthCur = lastSeqArray.length;

  _.each(seqArray, function (doc, i) {
    newIdObjects.push({_id: doc._id});
    posNew[idStringify(doc._id)] = i;
  });
  _.each(lastSeqArray, function (doc, i) {
    oldIdObjects.push({_id: doc._id});
    posOld[idStringify(doc._id)] = i;
    posCur[idStringify(doc._id)] = i;
  });

  // Arrays can contain arbitrary objects. We don't diff the
  // objects. Instead we always fire 'changedAt' callback on every
  // object. The consumer of `observe-sequence` should deal with
  // it appropriately.
  diffFn(oldIdObjects, newIdObjects, {
    addedBefore: function (id, doc, before) {
      var position = before ? posCur[idStringify(before)] : lengthCur;

      _.each(posCur, function (pos, id) {
        if (pos >= position)
          posCur[id]++;
      });

      lengthCur++;
      posCur[idStringify(id)] = position;

      callbacks.addedAt(
        id,
        seqArray[posNew[idStringify(id)]].item,
        position,
        before);
    },
    movedBefore: function (id, before) {
      var prevPosition = posCur[idStringify(id)];
      var position = before ? posCur[idStringify(before)] : lengthCur - 1;

      _.each(posCur, function (pos, id) {
        if (pos >= prevPosition && pos <= position)
          posCur[id]--;
        else if (pos <= prevPosition && pos >= position)
          posCur[id]++;
      });

      posCur[idStringify(id)] = position;

      callbacks.movedTo(
        id,
        seqArray[posNew[idStringify(id)]].item,
        prevPosition,
        position,
        before);
    },
    removed: function (id) {
      var prevPosition = posCur[idStringify(id)];

      _.each(posCur, function (pos, id) {
        if (pos >= prevPosition)
          posCur[id]--;
      });

      delete posCur[idStringify(id)];
      lengthCur--;

      callbacks.removedAt(
        id,
        lastSeqArray[posOld[idStringify(id)]].item,
        prevPosition);
    }
  });

  _.each(posNew, function (pos, idString) {
    var id = idParse(idString);
    if (_.has(posOld, idString)) {
      // specifically for primitive types, compare equality before
      // firing the 'changedAt' callback. otherwise, always fire it
      // because doing a deep EJSON comparison is not guaranteed to
      // work (an array can contain arbitrary objects, and 'transform'
      // can be used on cursors). also, deep diffing is not
      // necessarily the most efficient (if only a specific subfield
      // of the object is later accessed).
      var newItem = seqArray[pos].item;
      var oldItem = lastSeqArray[posOld[idString]].item;

      if (typeof newItem === 'object' || newItem !== oldItem)
          callbacks.changedAt(id, newItem, oldItem, pos);
      }
  });
};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['observe-sequence'] = {
  ObserveSequence: ObserveSequence
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var _ = Package.underscore._;

/* Package-scope variables */
var OrderedDict;

(function () {

                                                                                 //
// This file defines an ordered dictionary abstraction that is useful for
// maintaining a dataset backed by observeChanges.  It supports ordering items
// by specifying the item they now come before.

// The implementation is a dictionary that contains nodes of a doubly-linked
// list as its values.

// constructs a new element struct
// next and prev are whole elements, not keys.
var element = function (key, value, next, prev) {
  return {
    key: key,
    value: value,
    next: next,
    prev: prev
  };
};
OrderedDict = function (/* ... */) {
  var self = this;
  self._dict = {};
  self._first = null;
  self._last = null;
  self._size = 0;
  var args = _.toArray(arguments);
  self._stringify = function (x) { return x; };
  if (typeof args[0] === 'function')
    self._stringify = args.shift();
  _.each(args, function (kv) {
    self.putBefore(kv[0], kv[1], null);
  });
};

_.extend(OrderedDict.prototype, {
  // the "prefix keys with a space" thing comes from here
  // https://github.com/documentcloud/underscore/issues/376#issuecomment-2815649
  _k: function (key) { return " " + this._stringify(key); },

  empty: function () {
    var self = this;
    return !self._first;
  },
  size: function () {
    var self = this;
    return self._size;
  },
  _linkEltIn: function (elt) {
    var self = this;
    if (!elt.next) {
      elt.prev = self._last;
      if (self._last)
        self._last.next = elt;
      self._last = elt;
    } else {
      elt.prev = elt.next.prev;
      elt.next.prev = elt;
      if (elt.prev)
        elt.prev.next = elt;
    }
    if (self._first === null || self._first === elt.next)
      self._first = elt;
  },
  _linkEltOut: function (elt) {
    var self = this;
    if (elt.next)
      elt.next.prev = elt.prev;
    if (elt.prev)
      elt.prev.next = elt.next;
    if (elt === self._last)
      self._last = elt.prev;
    if (elt === self._first)
      self._first = elt.next;
  },
  putBefore: function (key, item, before) {
    var self = this;
    if (self._dict[self._k(key)])
      throw new Error("Item " + key + " already present in OrderedDict");
    var elt = before ?
          element(key, item, self._dict[self._k(before)]) :
          element(key, item, null);
    if (elt.next === undefined)
      throw new Error("could not find item to put this one before");
    self._linkEltIn(elt);
    self._dict[self._k(key)] = elt;
    self._size++;
  },
  append: function (key, item) {
    var self = this;
    self.putBefore(key, item, null);
  },
  remove: function (key) {
    var self = this;
    var elt = self._dict[self._k(key)];
    if (elt === undefined)
      throw new Error("Item " + key + " not present in OrderedDict");
    self._linkEltOut(elt);
    self._size--;
    delete self._dict[self._k(key)];
    return elt.value;
  },
  get: function (key) {
    var self = this;
    if (self.has(key))
        return self._dict[self._k(key)].value;
    return undefined;
  },
  has: function (key) {
    var self = this;
    return _.has(self._dict, self._k(key));
  },
  // Iterate through the items in this dictionary in order, calling
  // iter(value, key, index) on each one.

  // Stops whenever iter returns OrderedDict.BREAK, or after the last element.
  forEach: function (iter) {
    var self = this;
    var i = 0;
    var elt = self._first;
    while (elt !== null) {
      var b = iter(elt.value, elt.key, i);
      if (b === OrderedDict.BREAK)
        return;
      elt = elt.next;
      i++;
    }
  },
  first: function () {
    var self = this;
    if (self.empty())
      return undefined;
    return self._first.key;
  },
  firstValue: function () {
    var self = this;
    if (self.empty())
      return undefined;
    return self._first.value;
  },
  last: function () {
    var self = this;
    if (self.empty())
      return undefined;
    return self._last.key;
  },
  lastValue: function () {
    var self = this;
    if (self.empty())
      return undefined;
    return self._last.value;
  },
  prev: function (key) {
    var self = this;
    if (self.has(key)) {
      var elt = self._dict[self._k(key)];
      if (elt.prev)
        return elt.prev.key;
    }
    return null;
  },
  next: function (key) {
    var self = this;
    if (self.has(key)) {
      var elt = self._dict[self._k(key)];
      if (elt.next)
        return elt.next.key;
    }
    return null;
  },
  moveBefore: function (key, before) {
    var self = this;
    var elt = self._dict[self._k(key)];
    var eltBefore = before ? self._dict[self._k(before)] : null;
    if (elt === undefined)
      throw new Error("Item to move is not present");
    if (eltBefore === undefined) {
      throw new Error("Could not find element to move this one before");
    }
    if (eltBefore === elt.next) // no moving necessary
      return;
    // remove from its old place
    self._linkEltOut(elt);
    // patch into its new place
    elt.next = eltBefore;
    self._linkEltIn(elt);
  },
  // Linear, sadly.
  indexOf: function (key) {
    var self = this;
    var ret = null;
    self.forEach(function (v, k, i) {
      if (self._k(k) === self._k(key)) {
        ret = i;
        return OrderedDict.BREAK;
      }
      return undefined;
    });
    return ret;
  },
  _checkRep: function () {
    var self = this;
    _.each(self._dict, function (k, v) {
      if (v.next === v)
        throw new Error("Next is a loop");
      if (v.prev === v)
        throw new Error("Prev is a loop");
    });
  }

});
OrderedDict.BREAK = {"break": true};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['ordered-dict'] = {
  OrderedDict: OrderedDict
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var _ = Package.underscore._;

/* Package-scope variables */
var Random;

(function () {

                                                                                    //
// We use cryptographically strong PRNGs (crypto.getRandomBytes() on the server,
// window.crypto.getRandomValues() in the browser) when available. If these
// PRNGs fail, we fall back to the Alea PRNG, which is not cryptographically
// strong, and we seed it with various sources such as the date, Math.random,
// and window size on the client.  When using crypto.getRandomValues(), our
// primitive is hexString(), from which we construct fraction(). When using
// window.crypto.getRandomValues() or alea, the primitive is fraction and we use
// that to construct hex string.

if (Meteor.isServer)
  var nodeCrypto = Npm.require('crypto');

// see http://baagoe.org/en/wiki/Better_random_numbers_for_javascript
// for a full discussion and Alea implementation.
var Alea = function () {
  function Mash() {
    var n = 0xefc8249d;

    var mash = function(data) {
      data = data.toString();
      for (var i = 0; i < data.length; i++) {
        n += data.charCodeAt(i);
        var h = 0.02519603282416938 * n;
        n = h >>> 0;
        h -= n;
        h *= n;
        n = h >>> 0;
        h -= n;
        n += h * 0x100000000; // 2^32
      }
      return (n >>> 0) * 2.3283064365386963e-10; // 2^-32
    };

    mash.version = 'Mash 0.9';
    return mash;
  }

  return (function (args) {
    var s0 = 0;
    var s1 = 0;
    var s2 = 0;
    var c = 1;

    if (args.length == 0) {
      args = [+new Date];
    }
    var mash = Mash();
    s0 = mash(' ');
    s1 = mash(' ');
    s2 = mash(' ');

    for (var i = 0; i < args.length; i++) {
      s0 -= mash(args[i]);
      if (s0 < 0) {
        s0 += 1;
      }
      s1 -= mash(args[i]);
      if (s1 < 0) {
        s1 += 1;
      }
      s2 -= mash(args[i]);
      if (s2 < 0) {
        s2 += 1;
      }
    }
    mash = null;

    var random = function() {
      var t = 2091639 * s0 + c * 2.3283064365386963e-10; // 2^-32
      s0 = s1;
      s1 = s2;
      return s2 = t - (c = t | 0);
    };
    random.uint32 = function() {
      return random() * 0x100000000; // 2^32
    };
    random.fract53 = function() {
      return random() +
        (random() * 0x200000 | 0) * 1.1102230246251565e-16; // 2^-53
    };
    random.version = 'Alea 0.9';
    random.args = args;
    return random;

  } (Array.prototype.slice.call(arguments)));
};

var UNMISTAKABLE_CHARS = "23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz";
var BASE64_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  "0123456789-_";

// If seeds are provided, then the alea PRNG will be used, since cryptographic
// PRNGs (Node crypto and window.crypto.getRandomValues) don't allow us to
// specify seeds. The caller is responsible for making sure to provide a seed
// for alea if a csprng is not available.
var RandomGenerator = function (seedArray) {
  var self = this;
  if (seedArray !== undefined)
    self.alea = Alea.apply(null, seedArray);
};

RandomGenerator.prototype.fraction = function () {
  var self = this;
  if (self.alea) {
    return self.alea();
  } else if (nodeCrypto) {
    var numerator = parseInt(self.hexString(8), 16);
    return numerator * 2.3283064365386963e-10; // 2^-32
  } else if (typeof window !== "undefined" && window.crypto &&
             window.crypto.getRandomValues) {
    var array = new Uint32Array(1);
    window.crypto.getRandomValues(array);
    return array[0] * 2.3283064365386963e-10; // 2^-32
  } else {
    throw new Error('No random generator available');
  }
};

RandomGenerator.prototype.hexString = function (digits) {
  var self = this;
  if (nodeCrypto && ! self.alea) {
    var numBytes = Math.ceil(digits / 2);
    var bytes;
    // Try to get cryptographically strong randomness. Fall back to
    // non-cryptographically strong if not available.
    try {
      bytes = nodeCrypto.randomBytes(numBytes);
    } catch (e) {
      // XXX should re-throw any error except insufficient entropy
      bytes = nodeCrypto.pseudoRandomBytes(numBytes);
    }
    var result = bytes.toString("hex");
    // If the number of digits is odd, we'll have generated an extra 4 bits
    // of randomness, so we need to trim the last digit.
    return result.substring(0, digits);
  } else {
    var hexDigits = [];
    for (var i = 0; i < digits; ++i) {
      hexDigits.push(self.choice("0123456789abcdef"));
    }
    return hexDigits.join('');
  }
};

RandomGenerator.prototype._randomString = function (charsCount,
                                                    alphabet) {
  var self = this;
  var digits = [];
  for (var i = 0; i < charsCount; i++) {
    digits[i] = self.choice(alphabet);
  }
  return digits.join("");
};

RandomGenerator.prototype.id = function (charsCount) {
  var self = this;
  // 17 characters is around 96 bits of entropy, which is the amount of
  // state in the Alea PRNG.
  if (charsCount === undefined)
    charsCount = 17;

  return self._randomString(charsCount, UNMISTAKABLE_CHARS);
};

RandomGenerator.prototype.secret = function (charsCount) {
  var self = this;
  // Default to 256 bits of entropy, or 43 characters at 6 bits per
  // character.
  if (charsCount === undefined)
    charsCount = 43;
  return self._randomString(charsCount, BASE64_CHARS);
};

RandomGenerator.prototype.choice = function (arrayOrString) {
  var index = Math.floor(this.fraction() * arrayOrString.length);
  if (typeof arrayOrString === "string")
    return arrayOrString.substr(index, 1);
  else
    return arrayOrString[index];
};

// instantiate RNG.  Heuristically collect entropy from various sources when a
// cryptographic PRNG isn't available.

// client sources
var height = (typeof window !== 'undefined' && window.innerHeight) ||
      (typeof document !== 'undefined'
       && document.documentElement
       && document.documentElement.clientHeight) ||
      (typeof document !== 'undefined'
       && document.body
       && document.body.clientHeight) ||
      1;

var width = (typeof window !== 'undefined' && window.innerWidth) ||
      (typeof document !== 'undefined'
       && document.documentElement
       && document.documentElement.clientWidth) ||
      (typeof document !== 'undefined'
       && document.body
       && document.body.clientWidth) ||
      1;

var agent = (typeof navigator !== 'undefined' && navigator.userAgent) || "";

if (nodeCrypto ||
    (typeof window !== "undefined" &&
     window.crypto && window.crypto.getRandomValues))
  Random = new RandomGenerator();
else
  Random = new RandomGenerator([new Date(), height, width, agent, Math.random()]);

Random.createWithSeeds = function () {
  if (arguments.length === 0) {
    throw new Error('No seeds were provided');
  }
  return new RandomGenerator(arguments);
};


}).call(this);






(function () {

                                                                                    //
// Before this package existed, we used to use this Meteor.uuid()
// implementing the RFC 4122 v4 UUID. It is no longer documented
// and will go away.
// XXX COMPAT WITH 0.5.6
Meteor.uuid = function () {
  var HEX_DIGITS = "0123456789abcdef";
  var s = [];
  for (var i = 0; i < 36; i++) {
    s[i] = Random.choice(HEX_DIGITS);
  }
  s[14] = "4";
  s[19] = HEX_DIGITS.substr((parseInt(s[19],16) & 0x3) | 0x8, 1);
  s[8] = s[13] = s[18] = s[23] = "-";

  var uuid = s.join("");
  return uuid;
};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.random = {
  Random: Random
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var Spacebars = Package.spacebars.Spacebars;
var HTMLTools = Package['html-tools'].HTMLTools;
var _ = Package.underscore._;
var UI = Package.ui.UI;
var Handlebars = Package.ui.Handlebars;
var HTML = Package.htmljs.HTML;

/* Package-scope variables */
var parseNumber, parseIdentifierName, parseStringLiteral, toJSLiteral, toObjectLiteralKey, TemplateTag;

(function () {

                                                                                                        //

// Adapted from source code of http://xregexp.com/plugins/#unicode
var unicodeCategories = {
  Ll: "0061-007A00B500DF-00F600F8-00FF01010103010501070109010B010D010F01110113011501170119011B011D011F01210123012501270129012B012D012F01310133013501370138013A013C013E014001420144014601480149014B014D014F01510153015501570159015B015D015F01610163016501670169016B016D016F0171017301750177017A017C017E-0180018301850188018C018D019201950199-019B019E01A101A301A501A801AA01AB01AD01B001B401B601B901BA01BD-01BF01C601C901CC01CE01D001D201D401D601D801DA01DC01DD01DF01E101E301E501E701E901EB01ED01EF01F001F301F501F901FB01FD01FF02010203020502070209020B020D020F02110213021502170219021B021D021F02210223022502270229022B022D022F02310233-0239023C023F0240024202470249024B024D024F-02930295-02AF037103730377037B-037D039003AC-03CE03D003D103D5-03D703D903DB03DD03DF03E103E303E503E703E903EB03ED03EF-03F303F503F803FB03FC0430-045F04610463046504670469046B046D046F04710473047504770479047B047D047F0481048B048D048F04910493049504970499049B049D049F04A104A304A504A704A904AB04AD04AF04B104B304B504B704B904BB04BD04BF04C204C404C604C804CA04CC04CE04CF04D104D304D504D704D904DB04DD04DF04E104E304E504E704E904EB04ED04EF04F104F304F504F704F904FB04FD04FF05010503050505070509050B050D050F05110513051505170519051B051D051F05210523052505270561-05871D00-1D2B1D6B-1D771D79-1D9A1E011E031E051E071E091E0B1E0D1E0F1E111E131E151E171E191E1B1E1D1E1F1E211E231E251E271E291E2B1E2D1E2F1E311E331E351E371E391E3B1E3D1E3F1E411E431E451E471E491E4B1E4D1E4F1E511E531E551E571E591E5B1E5D1E5F1E611E631E651E671E691E6B1E6D1E6F1E711E731E751E771E791E7B1E7D1E7F1E811E831E851E871E891E8B1E8D1E8F1E911E931E95-1E9D1E9F1EA11EA31EA51EA71EA91EAB1EAD1EAF1EB11EB31EB51EB71EB91EBB1EBD1EBF1EC11EC31EC51EC71EC91ECB1ECD1ECF1ED11ED31ED51ED71ED91EDB1EDD1EDF1EE11EE31EE51EE71EE91EEB1EED1EEF1EF11EF31EF51EF71EF91EFB1EFD1EFF-1F071F10-1F151F20-1F271F30-1F371F40-1F451F50-1F571F60-1F671F70-1F7D1F80-1F871F90-1F971FA0-1FA71FB0-1FB41FB61FB71FBE1FC2-1FC41FC61FC71FD0-1FD31FD61FD71FE0-1FE71FF2-1FF41FF61FF7210A210E210F2113212F21342139213C213D2146-2149214E21842C30-2C5E2C612C652C662C682C6A2C6C2C712C732C742C76-2C7B2C812C832C852C872C892C8B2C8D2C8F2C912C932C952C972C992C9B2C9D2C9F2CA12CA32CA52CA72CA92CAB2CAD2CAF2CB12CB32CB52CB72CB92CBB2CBD2CBF2CC12CC32CC52CC72CC92CCB2CCD2CCF2CD12CD32CD52CD72CD92CDB2CDD2CDF2CE12CE32CE42CEC2CEE2CF32D00-2D252D272D2DA641A643A645A647A649A64BA64DA64FA651A653A655A657A659A65BA65DA65FA661A663A665A667A669A66BA66DA681A683A685A687A689A68BA68DA68FA691A693A695A697A723A725A727A729A72BA72DA72F-A731A733A735A737A739A73BA73DA73FA741A743A745A747A749A74BA74DA74FA751A753A755A757A759A75BA75DA75FA761A763A765A767A769A76BA76DA76FA771-A778A77AA77CA77FA781A783A785A787A78CA78EA791A793A7A1A7A3A7A5A7A7A7A9A7FAFB00-FB06FB13-FB17FF41-FF5A",
  Lm: "02B0-02C102C6-02D102E0-02E402EC02EE0374037A0559064006E506E607F407F507FA081A0824082809710E460EC610FC17D718431AA71C78-1C7D1D2C-1D6A1D781D9B-1DBF2071207F2090-209C2C7C2C7D2D6F2E2F30053031-3035303B309D309E30FC-30FEA015A4F8-A4FDA60CA67FA717-A71FA770A788A7F8A7F9A9CFAA70AADDAAF3AAF4FF70FF9EFF9F",
  Lo: "00AA00BA01BB01C0-01C3029405D0-05EA05F0-05F20620-063F0641-064A066E066F0671-06D306D506EE06EF06FA-06FC06FF07100712-072F074D-07A507B107CA-07EA0800-08150840-085808A008A2-08AC0904-0939093D09500958-09610972-09770979-097F0985-098C098F09900993-09A809AA-09B009B209B6-09B909BD09CE09DC09DD09DF-09E109F009F10A05-0A0A0A0F0A100A13-0A280A2A-0A300A320A330A350A360A380A390A59-0A5C0A5E0A72-0A740A85-0A8D0A8F-0A910A93-0AA80AAA-0AB00AB20AB30AB5-0AB90ABD0AD00AE00AE10B05-0B0C0B0F0B100B13-0B280B2A-0B300B320B330B35-0B390B3D0B5C0B5D0B5F-0B610B710B830B85-0B8A0B8E-0B900B92-0B950B990B9A0B9C0B9E0B9F0BA30BA40BA8-0BAA0BAE-0BB90BD00C05-0C0C0C0E-0C100C12-0C280C2A-0C330C35-0C390C3D0C580C590C600C610C85-0C8C0C8E-0C900C92-0CA80CAA-0CB30CB5-0CB90CBD0CDE0CE00CE10CF10CF20D05-0D0C0D0E-0D100D12-0D3A0D3D0D4E0D600D610D7A-0D7F0D85-0D960D9A-0DB10DB3-0DBB0DBD0DC0-0DC60E01-0E300E320E330E40-0E450E810E820E840E870E880E8A0E8D0E94-0E970E99-0E9F0EA1-0EA30EA50EA70EAA0EAB0EAD-0EB00EB20EB30EBD0EC0-0EC40EDC-0EDF0F000F40-0F470F49-0F6C0F88-0F8C1000-102A103F1050-1055105A-105D106110651066106E-10701075-1081108E10D0-10FA10FD-1248124A-124D1250-12561258125A-125D1260-1288128A-128D1290-12B012B2-12B512B8-12BE12C012C2-12C512C8-12D612D8-13101312-13151318-135A1380-138F13A0-13F41401-166C166F-167F1681-169A16A0-16EA1700-170C170E-17111720-17311740-17511760-176C176E-17701780-17B317DC1820-18421844-18771880-18A818AA18B0-18F51900-191C1950-196D1970-19741980-19AB19C1-19C71A00-1A161A20-1A541B05-1B331B45-1B4B1B83-1BA01BAE1BAF1BBA-1BE51C00-1C231C4D-1C4F1C5A-1C771CE9-1CEC1CEE-1CF11CF51CF62135-21382D30-2D672D80-2D962DA0-2DA62DA8-2DAE2DB0-2DB62DB8-2DBE2DC0-2DC62DC8-2DCE2DD0-2DD62DD8-2DDE3006303C3041-3096309F30A1-30FA30FF3105-312D3131-318E31A0-31BA31F0-31FF3400-4DB54E00-9FCCA000-A014A016-A48CA4D0-A4F7A500-A60BA610-A61FA62AA62BA66EA6A0-A6E5A7FB-A801A803-A805A807-A80AA80C-A822A840-A873A882-A8B3A8F2-A8F7A8FBA90A-A925A930-A946A960-A97CA984-A9B2AA00-AA28AA40-AA42AA44-AA4BAA60-AA6FAA71-AA76AA7AAA80-AAAFAAB1AAB5AAB6AAB9-AABDAAC0AAC2AADBAADCAAE0-AAEAAAF2AB01-AB06AB09-AB0EAB11-AB16AB20-AB26AB28-AB2EABC0-ABE2AC00-D7A3D7B0-D7C6D7CB-D7FBF900-FA6DFA70-FAD9FB1DFB1F-FB28FB2A-FB36FB38-FB3CFB3EFB40FB41FB43FB44FB46-FBB1FBD3-FD3DFD50-FD8FFD92-FDC7FDF0-FDFBFE70-FE74FE76-FEFCFF66-FF6FFF71-FF9DFFA0-FFBEFFC2-FFC7FFCA-FFCFFFD2-FFD7FFDA-FFDC",
  Lt: "01C501C801CB01F21F88-1F8F1F98-1F9F1FA8-1FAF1FBC1FCC1FFC",
  Lu: "0041-005A00C0-00D600D8-00DE01000102010401060108010A010C010E01100112011401160118011A011C011E01200122012401260128012A012C012E01300132013401360139013B013D013F0141014301450147014A014C014E01500152015401560158015A015C015E01600162016401660168016A016C016E017001720174017601780179017B017D018101820184018601870189-018B018E-0191019301940196-0198019C019D019F01A001A201A401A601A701A901AC01AE01AF01B1-01B301B501B701B801BC01C401C701CA01CD01CF01D101D301D501D701D901DB01DE01E001E201E401E601E801EA01EC01EE01F101F401F6-01F801FA01FC01FE02000202020402060208020A020C020E02100212021402160218021A021C021E02200222022402260228022A022C022E02300232023A023B023D023E02410243-02460248024A024C024E03700372037603860388-038A038C038E038F0391-03A103A3-03AB03CF03D2-03D403D803DA03DC03DE03E003E203E403E603E803EA03EC03EE03F403F703F903FA03FD-042F04600462046404660468046A046C046E04700472047404760478047A047C047E0480048A048C048E04900492049404960498049A049C049E04A004A204A404A604A804AA04AC04AE04B004B204B404B604B804BA04BC04BE04C004C104C304C504C704C904CB04CD04D004D204D404D604D804DA04DC04DE04E004E204E404E604E804EA04EC04EE04F004F204F404F604F804FA04FC04FE05000502050405060508050A050C050E05100512051405160518051A051C051E05200522052405260531-055610A0-10C510C710CD1E001E021E041E061E081E0A1E0C1E0E1E101E121E141E161E181E1A1E1C1E1E1E201E221E241E261E281E2A1E2C1E2E1E301E321E341E361E381E3A1E3C1E3E1E401E421E441E461E481E4A1E4C1E4E1E501E521E541E561E581E5A1E5C1E5E1E601E621E641E661E681E6A1E6C1E6E1E701E721E741E761E781E7A1E7C1E7E1E801E821E841E861E881E8A1E8C1E8E1E901E921E941E9E1EA01EA21EA41EA61EA81EAA1EAC1EAE1EB01EB21EB41EB61EB81EBA1EBC1EBE1EC01EC21EC41EC61EC81ECA1ECC1ECE1ED01ED21ED41ED61ED81EDA1EDC1EDE1EE01EE21EE41EE61EE81EEA1EEC1EEE1EF01EF21EF41EF61EF81EFA1EFC1EFE1F08-1F0F1F18-1F1D1F28-1F2F1F38-1F3F1F48-1F4D1F591F5B1F5D1F5F1F68-1F6F1FB8-1FBB1FC8-1FCB1FD8-1FDB1FE8-1FEC1FF8-1FFB21022107210B-210D2110-211221152119-211D212421262128212A-212D2130-2133213E213F214521832C00-2C2E2C602C62-2C642C672C692C6B2C6D-2C702C722C752C7E-2C802C822C842C862C882C8A2C8C2C8E2C902C922C942C962C982C9A2C9C2C9E2CA02CA22CA42CA62CA82CAA2CAC2CAE2CB02CB22CB42CB62CB82CBA2CBC2CBE2CC02CC22CC42CC62CC82CCA2CCC2CCE2CD02CD22CD42CD62CD82CDA2CDC2CDE2CE02CE22CEB2CED2CF2A640A642A644A646A648A64AA64CA64EA650A652A654A656A658A65AA65CA65EA660A662A664A666A668A66AA66CA680A682A684A686A688A68AA68CA68EA690A692A694A696A722A724A726A728A72AA72CA72EA732A734A736A738A73AA73CA73EA740A742A744A746A748A74AA74CA74EA750A752A754A756A758A75AA75CA75EA760A762A764A766A768A76AA76CA76EA779A77BA77DA77EA780A782A784A786A78BA78DA790A792A7A0A7A2A7A4A7A6A7A8A7AAFF21-FF3A",
  Mc: "0903093B093E-09400949-094C094E094F0982098309BE-09C009C709C809CB09CC09D70A030A3E-0A400A830ABE-0AC00AC90ACB0ACC0B020B030B3E0B400B470B480B4B0B4C0B570BBE0BBF0BC10BC20BC6-0BC80BCA-0BCC0BD70C01-0C030C41-0C440C820C830CBE0CC0-0CC40CC70CC80CCA0CCB0CD50CD60D020D030D3E-0D400D46-0D480D4A-0D4C0D570D820D830DCF-0DD10DD8-0DDF0DF20DF30F3E0F3F0F7F102B102C10311038103B103C105610571062-10641067-106D108310841087-108C108F109A-109C17B617BE-17C517C717C81923-19261929-192B193019311933-193819B0-19C019C819C91A19-1A1B1A551A571A611A631A641A6D-1A721B041B351B3B1B3D-1B411B431B441B821BA11BA61BA71BAA1BAC1BAD1BE71BEA-1BEC1BEE1BF21BF31C24-1C2B1C341C351CE11CF21CF3302E302FA823A824A827A880A881A8B4-A8C3A952A953A983A9B4A9B5A9BAA9BBA9BD-A9C0AA2FAA30AA33AA34AA4DAA7BAAEBAAEEAAEFAAF5ABE3ABE4ABE6ABE7ABE9ABEAABEC",
  Mn: "0300-036F0483-04870591-05BD05BF05C105C205C405C505C70610-061A064B-065F067006D6-06DC06DF-06E406E706E806EA-06ED07110730-074A07A6-07B007EB-07F30816-0819081B-08230825-08270829-082D0859-085B08E4-08FE0900-0902093A093C0941-0948094D0951-095709620963098109BC09C1-09C409CD09E209E30A010A020A3C0A410A420A470A480A4B-0A4D0A510A700A710A750A810A820ABC0AC1-0AC50AC70AC80ACD0AE20AE30B010B3C0B3F0B41-0B440B4D0B560B620B630B820BC00BCD0C3E-0C400C46-0C480C4A-0C4D0C550C560C620C630CBC0CBF0CC60CCC0CCD0CE20CE30D41-0D440D4D0D620D630DCA0DD2-0DD40DD60E310E34-0E3A0E47-0E4E0EB10EB4-0EB90EBB0EBC0EC8-0ECD0F180F190F350F370F390F71-0F7E0F80-0F840F860F870F8D-0F970F99-0FBC0FC6102D-10301032-10371039103A103D103E10581059105E-10601071-1074108210851086108D109D135D-135F1712-17141732-1734175217531772177317B417B517B7-17BD17C617C9-17D317DD180B-180D18A91920-19221927192819321939-193B1A171A181A561A58-1A5E1A601A621A65-1A6C1A73-1A7C1A7F1B00-1B031B341B36-1B3A1B3C1B421B6B-1B731B801B811BA2-1BA51BA81BA91BAB1BE61BE81BE91BED1BEF-1BF11C2C-1C331C361C371CD0-1CD21CD4-1CE01CE2-1CE81CED1CF41DC0-1DE61DFC-1DFF20D0-20DC20E120E5-20F02CEF-2CF12D7F2DE0-2DFF302A-302D3099309AA66FA674-A67DA69FA6F0A6F1A802A806A80BA825A826A8C4A8E0-A8F1A926-A92DA947-A951A980-A982A9B3A9B6-A9B9A9BCAA29-AA2EAA31AA32AA35AA36AA43AA4CAAB0AAB2-AAB4AAB7AAB8AABEAABFAAC1AAECAAEDAAF6ABE5ABE8ABEDFB1EFE00-FE0FFE20-FE26",
  Nd: "0030-00390660-066906F0-06F907C0-07C90966-096F09E6-09EF0A66-0A6F0AE6-0AEF0B66-0B6F0BE6-0BEF0C66-0C6F0CE6-0CEF0D66-0D6F0E50-0E590ED0-0ED90F20-0F291040-10491090-109917E0-17E91810-18191946-194F19D0-19D91A80-1A891A90-1A991B50-1B591BB0-1BB91C40-1C491C50-1C59A620-A629A8D0-A8D9A900-A909A9D0-A9D9AA50-AA59ABF0-ABF9FF10-FF19",
  Nl: "16EE-16F02160-21822185-218830073021-30293038-303AA6E6-A6EF",
  Pc: "005F203F20402054FE33FE34FE4D-FE4FFF3F"
};

var unicodeClass = function (abbrev) {
  return '[' +
    unicodeCategories[abbrev].replace(/[0-9A-F]{4}/ig, "\\u$&") + ']';
};

// See ECMA-262 spec, 3rd edition, Section 7.6
// Match one or more characters that can start an identifier.
// This is IdentifierStart+.
var rIdentifierPrefix = new RegExp(
  "^([a-zA-Z$_]+|\\\\u[0-9a-fA-F]{4}|" +
    [unicodeClass('Lu'), unicodeClass('Ll'), unicodeClass('Lt'),
     unicodeClass('Lm'), unicodeClass('Lo'), unicodeClass('Nl')].join('|') +
    ")+");
// Match one or more characters that can continue an identifier.
// This is (IdentifierPart and not IdentifierStart)+.
// To match a full identifier, match rIdentifierPrefix, then
// match rIdentifierMiddle followed by rIdentifierPrefix until they both fail.
var rIdentifierMiddle = new RegExp(
  "^([0-9]|" + [unicodeClass('Mn'), unicodeClass('Mc'), unicodeClass('Nd'),
                unicodeClass('Pc')].join('|') + ")+");


// See ECMA-262 spec, 3rd edition, Section 7.8.3
var rHexLiteral = /^0[xX][0-9a-fA-F]+(?!\w)/;
var rDecLiteral =
      /^(((0|[1-9][0-9]*)(\.[0-9]*)?)|\.[0-9]+)([Ee][+-]?[0-9]+)?(?!\w)/;

// Section 7.8.4
var rStringQuote = /^["']/;
// Match one or more characters besides quotes, backslashes, or line ends
var rStringMiddle = /^(?=.)[^"'\\]+?((?!.)|(?=["'\\]))/;
// Match one escape sequence, including the backslash.
var rEscapeSequence =
      /^\\(['"\\bfnrtv]|0(?![0-9])|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|(?=.)[^ux0-9])/;
// Match one ES5 line continuation
var rLineContinuation =
      /^\\(\r\n|[\u000A\u000D\u2028\u2029])/;


parseNumber = function (scanner) {
  var startPos = scanner.pos;

  var isNegative = false;
  if (scanner.peek() === '-') {
    scanner.pos++;
    isNegative = true;
  }
  // Note that we allow `"-0xa"`, unlike `Number(...)`.

  var rest = scanner.rest();
  var match = rDecLiteral.exec(rest) || rHexLiteral.exec(rest);
  if (! match) {
    scanner.pos = startPos;
    return null;
  }
  var matchText = match[0];
  scanner.pos += matchText.length;

  var text = (isNegative ? '-' : '') + matchText;
  var value = Number(matchText);
  value = (isNegative ? -value : value);
  return { text: text, value: value };
};

parseIdentifierName = function (scanner) {
  var startPos = scanner.pos;
  var rest = scanner.rest();
  var match = rIdentifierPrefix.exec(rest);
  if (! match)
    return null;
  scanner.pos += match[0].length;
  rest = scanner.rest();
  var foundMore = true;

  while (foundMore) {
    foundMore = false;

    match = rIdentifierMiddle.exec(rest);
    if (match) {
      foundMore = true;
      scanner.pos += match[0].length;
      rest = scanner.rest();
    }

    match = rIdentifierPrefix.exec(rest);
    if (match) {
      foundMore = true;
      scanner.pos += match[0].length;
      rest = scanner.rest();
    }
  }

  return scanner.input.substring(startPos, scanner.pos);
};

parseStringLiteral = function (scanner) {
  var startPos = scanner.pos;
  var rest = scanner.rest();
  var match = rStringQuote.exec(rest);
  if (! match)
    return null;

  var quote = match[0];
  scanner.pos++;
  rest = scanner.rest();

  var jsonLiteral = '"';

  while (match) {
    match = rStringMiddle.exec(rest);
    if (match) {
      jsonLiteral += match[0];
    } else {
      match = rEscapeSequence.exec(rest);
      if (match) {
        var esc = match[0];
        // Convert all string escapes to JSON-compatible string escapes, so we
        // can use JSON.parse for some of the work.  JSON strings are not the
        // same as JS strings.  They don't support `\0`, `\v`, `\'`, or hex
        // escapes.
        if (esc === '\\0')
          jsonLiteral += '\\u0000';
        else if (esc === '\\v')
          // Note: IE 8 doesn't correctly parse '\v' in JavaScript.
          jsonLiteral += '\\u000b';
        else if (esc.charAt(1) === 'x')
          jsonLiteral += '\\u00' + esc.slice(2);
        else if (esc === '\\\'')
          jsonLiteral += "'";
        else
          jsonLiteral += esc;
      } else {
        match = rLineContinuation.exec(rest);
        if (! match) {
          match = rStringQuote.exec(rest);
          if (match) {
            var c = match[0];
            if (c !== quote) {
              if (c === '"')
                jsonLiteral += '\\';
              jsonLiteral += c;
            }
          }
        }
      }
    }
    if (match) {
      scanner.pos += match[0].length;
      rest = scanner.rest();
      if (match[0] === quote)
        break;
    }
  }

  if (match[0] !== quote)
    scanner.fatal("Unterminated string literal");

  jsonLiteral += '"';
  var text = scanner.input.substring(startPos, scanner.pos);
  var value = JSON.parse(jsonLiteral);
  return { text: text, value: value };
};

// expose for testing
Spacebars._$ = {
  parseNumber: parseNumber,
  parseIdentifierName: parseIdentifierName,
  parseStringLiteral: parseStringLiteral
};


}).call(this);






(function () {

                                                                                                        //

// Turns any JSONable value into a JavaScript literal.
toJSLiteral = function (obj) {
  // See <http://timelessrepo.com/json-isnt-a-javascript-subset> for `\u2028\u2029`.
  // Also escape Unicode surrogates.
  return (JSON.stringify(obj)
          .replace(/[\u2028\u2029\ud800-\udfff]/g, function (c) {
            return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
          }));
};



var jsReservedWordSet = (function (set) {
  _.each("abstract else instanceof super boolean enum int switch break export interface synchronized byte extends let this case false long throw catch final native throws char finally new transient class float null true const for package try continue function private typeof debugger goto protected var default if public void delete implements return volatile do import short while double in static with".split(' '), function (w) {
    set[w] = 1;
  });
  return set;
})({});

toObjectLiteralKey = function (k) {
  if (/^[a-zA-Z$_][a-zA-Z$0-9_]*$/.test(k) && jsReservedWordSet[k] !== 1)
    return k;
  return toJSLiteral(k);
};

// This method is generic, i.e. it can be transplanted to non-Tags
// and it will still work by accessing `this.tagName`, `this.attrs`,
// and `this.children`.  It's ok if `this.attrs` has content that
// isn't allowed in an attribute (this feature is used by
// HTMLTools.Special.prototype.toJS).
HTML.Tag.prototype.toJS = function (options) {
  var argStrs = [];
  if (this.attrs) {
    var kvStrs = [];
    for (var k in this.attrs) {
      if (! HTML.isNully(this.attrs[k]))
        kvStrs.push(toObjectLiteralKey(k) + ': ' +
                    HTML.toJS(this.attrs[k], options));
    }
    if (kvStrs.length)
      argStrs.push('{' + kvStrs.join(', ') + '}');
  }

  for (var i = 0; i < this.children.length; i++) {
    argStrs.push(HTML.toJS(this.children[i], options));
  }

  var tagName = this.tagName;
  var tagSymbol;
  if (! (this instanceof HTML.Tag))
    // a CharRef or Comment, say
    tagSymbol = (tagName.indexOf('.') >= 0 ? tagName : 'HTML.' + tagName);
  else if (! HTML.isTagEnsured(tagName))
    tagSymbol = 'HTML.getTag(' + toJSLiteral(tagName) + ')';
  else
    tagSymbol = 'HTML.' + HTML.getSymbolName(tagName);

  return tagSymbol + '(' + argStrs.join(', ') + ')';
};

HTML.CharRef.prototype.toJS = function (options) {
  return HTML.Tag.prototype.toJS.call({tagName: "CharRef",
                                       attrs: {html: this.html,
                                               str: this.str},
                                       children: []},
                                      options);
};

HTML.Comment.prototype.toJS = function (options) {
  return HTML.Tag.prototype.toJS.call({tagName: "Comment",
                                       attrs: null,
                                       children: [this.value]},
                                      options);
};

HTML.Raw.prototype.toJS = function (options) {
  return HTML.Tag.prototype.toJS.call({tagName: "Raw",
                                       attrs: null,
                                       children: [this.value]},
                                      options);
};

HTML.EmitCode.prototype.toJS = function (options) {
  return this.value;
};

HTML.toJS = function (node, options) {
  if (node == null) {
    // null or undefined
    return 'null';
  } else if ((typeof node === 'string') || (typeof node === 'boolean') || (typeof node === 'number')) {
    // string (or something that will be rendered as a string)
    return toJSLiteral(node);
  } else if (node instanceof Array) {
    // array
    var parts = [];
    for (var i = 0; i < node.length; i++)
      parts.push(HTML.toJS(node[i], options));
    return '[' + parts.join(', ') + ']';
  } else if (node.toJS) {
    // Tag or something else
    return node.toJS(options);
  } else {
    throw new Error("Expected tag, string, array, null, undefined, or " +
                    "object with a toJS method; found: " + node);
  }
};


}).call(this);






(function () {

                                                                                                        //
// A TemplateTag is the result of parsing a single `{{...}}` tag.
//
// The `.type` of a TemplateTag is one of:
//
// - `"DOUBLE"` - `{{foo}}`
// - `"TRIPLE"` - `{{{foo}}}`
// - `"COMMENT"` - `{{! foo}}`
// - `"INCLUSION"` - `{{> foo}}`
// - `"BLOCKOPEN"` - `{{#foo}}`
// - `"BLOCKCLOSE"` - `{{/foo}}`
// - `"ELSE"` - `{{else}}`
//
// Besides `type`, the mandatory properties of a TemplateTag are:
//
// - `path` - An array of one or more strings.  The path of `{{foo.bar}}`
//   is `["foo", "bar"]`.  Applies to DOUBLE, TRIPLE, INCLUSION, BLOCKOPEN,
//   and BLOCKCLOSE.
//
// - `args` - An array of zero or more argument specs.  An argument spec
//   is a two or three element array, consisting of a type, value, and
//   optional keyword name.  For example, the `args` of `{{foo "bar" x=3}}`
//   are `[["STRING", "bar"], ["NUMBER", 3, "x"]]`.  Applies to DOUBLE,
//   TRIPLE, INCLUSION, and BLOCKOPEN.
//
// - `value` - For COMMENT tags, a string of the comment's text.
//
// These additional are typically set during parsing:
//
// - `position` - The HTMLTools.TEMPLATE_TAG_POSITION specifying at what sort
//   of site the TemplateTag was encountered (e.g. at element level or as
//   part of an attribute value). Its absence implies
//   TEMPLATE_TAG_POSITION.ELEMENT.
//
// - `content` and `elseContent` - When a BLOCKOPEN tag's contents are
//   parsed, they are put here.  `elseContent` will only be present if
//   an `{{else}}` was found.

var TEMPLATE_TAG_POSITION = HTMLTools.TEMPLATE_TAG_POSITION;

TemplateTag = Spacebars.TemplateTag = function () {};

var makeStacheTagStartRegex = function (r) {
  return new RegExp(r.source + /(?![{>!#/])/.source,
                    r.ignoreCase ? 'i' : '');
};

var starts = {
  ELSE: makeStacheTagStartRegex(/^\{\{\s*else(?=[\s}])/i),
  DOUBLE: makeStacheTagStartRegex(/^\{\{\s*(?!\s)/),
  TRIPLE: makeStacheTagStartRegex(/^\{\{\{\s*(?!\s)/),
  BLOCKCOMMENT: makeStacheTagStartRegex(/^\{\{\s*!--/),
  COMMENT: makeStacheTagStartRegex(/^\{\{\s*!/),
  INCLUSION: makeStacheTagStartRegex(/^\{\{\s*>\s*(?!\s)/),
  BLOCKOPEN: makeStacheTagStartRegex(/^\{\{\s*#\s*(?!\s)/),
  BLOCKCLOSE: makeStacheTagStartRegex(/^\{\{\s*\/\s*(?!\s)/)
};

var ends = {
  DOUBLE: /^\s*\}\}/,
  TRIPLE: /^\s*\}\}\}/
};

// Parse a tag from the provided scanner or string.  If the input
// doesn't start with `{{`, returns null.  Otherwise, either succeeds
// and returns a Spacebars.TemplateTag, or throws an error (using
// `scanner.fatal` if a scanner is provided).
TemplateTag.parse = function (scannerOrString) {
  var scanner = scannerOrString;
  if (typeof scanner === 'string')
    scanner = new HTMLTools.Scanner(scannerOrString);

  if (! (scanner.peek() === '{' &&
         (scanner.rest()).slice(0, 2) === '{{'))
    return null;

  var run = function (regex) {
    // regex is assumed to start with `^`
    var result = regex.exec(scanner.rest());
    if (! result)
      return null;
    var ret = result[0];
    scanner.pos += ret.length;
    return ret;
  };

  var advance = function (amount) {
    scanner.pos += amount;
  };

  var scanIdentifier = function (isFirstInPath) {
    var id = parseIdentifierName(scanner);
    if (! id)
      expected('IDENTIFIER');
    if (isFirstInPath &&
        (id === 'null' || id === 'true' || id === 'false'))
      scanner.fatal("Can't use null, true, or false, as an identifier at start of path");

    return id;
  };

  var scanPath = function () {
    var segments = [];

    // handle initial `.`, `..`, `./`, `../`, `../..`, `../../`, etc
    var dots;
    if ((dots = run(/^[\.\/]+/))) {
      var ancestorStr = '.'; // eg `../../..` maps to `....`
      var endsWithSlash = /\/$/.test(dots);

      if (endsWithSlash)
        dots = dots.slice(0, -1);

      _.each(dots.split('/'), function(dotClause, index) {
        if (index === 0) {
          if (dotClause !== '.' && dotClause !== '..')
            expected("`.`, `..`, `./` or `../`");
        } else {
          if (dotClause !== '..')
            expected("`..` or `../`");
        }

        if (dotClause === '..')
          ancestorStr += '.';
      });

      segments.push(ancestorStr);

      if (!endsWithSlash)
        return segments;
    }

    while (true) {
      // scan a path segment

      if (run(/^\[/)) {
        var seg = run(/^[\s\S]*?\]/);
        if (! seg)
          error("Unterminated path segment");
        seg = seg.slice(0, -1);
        if (! seg && ! segments.length)
          error("Path can't start with empty string");
        segments.push(seg);
      } else {
        var id = scanIdentifier(! segments.length);
        if (id === 'this') {
          if (! segments.length) {
            // initial `this`
            segments.push('.');
          } else {
            error("Can only use `this` at the beginning of a path.\nInstead of `foo.this` or `../this`, just write `foo` or `..`.");
          }
        } else {
          segments.push(id);
        }
      }

      var sep = run(/^[\.\/]/);
      if (! sep)
        break;
    }

    return segments;
  };

  // scan the keyword portion of a keyword argument
  // (the "foo" portion in "foo=bar").
  // Result is either the keyword matched, or null
  // if we're not at a keyword argument position.
  var scanArgKeyword = function () {
    var match = /^([^\{\}\(\)\>#=\s]+)\s*=\s*/.exec(scanner.rest());
    if (match) {
      scanner.pos += match[0].length;
      return match[1];
    } else {
      return null;
    }
  };

  // scan an argument; succeeds or errors.
  // Result is an array of two or three items:
  // type , value, and (indicating a keyword argument)
  // keyword name.
  var scanArg = function () {
    var keyword = scanArgKeyword(); // null if not parsing a kwarg
    var value = scanArgValue();
    return keyword ? value.concat(keyword) : value;
  };

  // scan an argument value (for keyword or positional arguments);
  // succeeds or errors.  Result is an array of type, value.
  var scanArgValue = function () {
    var startPos = scanner.pos;
    var result;
    if ((result = parseNumber(scanner))) {
      return ['NUMBER', result.value];
    } else if ((result = parseStringLiteral(scanner))) {
      return ['STRING', result.value];
    } else if (/^[\.\[]/.test(scanner.peek())) {
      return ['PATH', scanPath()];
    } else if ((result = parseIdentifierName(scanner))) {
      var id = result;
      if (id === 'null') {
        return ['NULL', null];
      } else if (id === 'true' || id === 'false') {
        return ['BOOLEAN', id === 'true'];
      } else {
        scanner.pos = startPos; // unconsume `id`
        return ['PATH', scanPath()];
      }
    } else {
      expected('identifier, number, string, boolean, or null');
    }
  };

  var type;

  var error = function (msg) {
    scanner.fatal(msg);
  };

  var expected = function (what) {
    error('Expected ' + what);
  };

  // must do ELSE first; order of others doesn't matter

  if (run(starts.ELSE)) type = 'ELSE';
  else if (run(starts.DOUBLE)) type = 'DOUBLE';
  else if (run(starts.TRIPLE)) type = 'TRIPLE';
  else if (run(starts.BLOCKCOMMENT)) type = 'BLOCKCOMMENT';
  else if (run(starts.COMMENT)) type = 'COMMENT';
  else if (run(starts.INCLUSION)) type = 'INCLUSION';
  else if (run(starts.BLOCKOPEN)) type = 'BLOCKOPEN';
  else if (run(starts.BLOCKCLOSE)) type = 'BLOCKCLOSE';
  else
    error('Unknown stache tag');

  var tag = new TemplateTag;
  tag.type = type;

  if (type === 'BLOCKCOMMENT') {
    var result = run(/^[\s\S]*?--\s*?\}\}/);
    if (! result)
      error("Unclosed block comment");
    tag.value = result.slice(0, result.lastIndexOf('--'));
  } else if (type === 'COMMENT') {
    var result = run(/^[\s\S]*?\}\}/);
    if (! result)
      error("Unclosed comment");
    tag.value = result.slice(0, -2);
  } else if (type === 'BLOCKCLOSE') {
    tag.path = scanPath();
    if (! run(ends.DOUBLE))
      expected('`}}`');
  } else if (type === 'ELSE') {
    if (! run(ends.DOUBLE))
      expected('`}}`');
  } else {
    // DOUBLE, TRIPLE, BLOCKOPEN, INCLUSION
    tag.path = scanPath();
    tag.args = [];
    var foundKwArg = false;
    while (true) {
      run(/^\s*/);
      if (type === 'TRIPLE') {
        if (run(ends.TRIPLE))
          break;
        else if (scanner.peek() === '}')
          expected('`}}}`');
      } else {
        if (run(ends.DOUBLE))
          break;
        else if (scanner.peek() === '}')
          expected('`}}`');
      }
      var newArg = scanArg();
      if (newArg.length === 3) {
        foundKwArg = true;
      } else {
        if (foundKwArg)
          error("Can't have a non-keyword argument after a keyword argument");
      }
      tag.args.push(newArg);

      if (run(/^(?=[\s}])/) !== '')
        expected('space');
    }
  }

  return tag;
};

// Returns a Spacebars.TemplateTag parsed from `scanner`, leaving scanner
// at its original position.
//
// An error will still be thrown if there is not a valid template tag at
// the current position.
TemplateTag.peek = function (scanner) {
  var startPos = scanner.pos;
  var result = TemplateTag.parse(scanner);
  scanner.pos = startPos;
  return result;
};

// Like `TemplateTag.parse`, but in the case of blocks, parse the complete
// `{{#foo}}...{{/foo}}` with `content` and possible `elseContent`, rather
// than just the BLOCKOPEN tag.
//
// In addition:
//
// - Throws an error if `{{else}}` or `{{/foo}}` tag is encountered.
//
// - Returns `null` for a COMMENT.  (This case is distinguishable from
//   parsing no tag by the fact that the scanner is advanced.)
//
// - Takes an HTMLTools.TEMPLATE_TAG_POSITION `position` and sets it as the
//   TemplateTag's `.position` property.
//
// - Validates the tag's well-formedness and legality at in its position.
TemplateTag.parseCompleteTag = function (scannerOrString, position) {
  var scanner = scannerOrString;
  if (typeof scanner === 'string')
    scanner = new HTMLTools.Scanner(scannerOrString);

  var startPos = scanner.pos; // for error messages
  var result = TemplateTag.parse(scannerOrString);
  if (! result)
    return result;

  if (result.type === 'BLOCKCOMMENT')
    return null;

  if (result.type === 'COMMENT')
    return null;

  if (result.type === 'ELSE')
    scanner.fatal("Unexpected {{else}}");

  if (result.type === 'BLOCKCLOSE')
    scanner.fatal("Unexpected closing template tag");

  position = (position || TEMPLATE_TAG_POSITION.ELEMENT);
  if (position !== TEMPLATE_TAG_POSITION.ELEMENT)
    result.position = position;

  if (result.type === 'BLOCKOPEN') {
    // parse block contents

    // Construct a string version of `.path` for comparing start and
    // end tags.  For example, `foo/[0]` was parsed into `["foo", "0"]`
    // and now becomes `foo,0`.  This form may also show up in error
    // messages.
    var blockName = result.path.join(',');

    var textMode = null;
      if (blockName === 'markdown' ||
          position === TEMPLATE_TAG_POSITION.IN_RAWTEXT) {
        textMode = HTML.TEXTMODE.STRING;
      } else if (position === TEMPLATE_TAG_POSITION.IN_RCDATA ||
                 position === TEMPLATE_TAG_POSITION.IN_ATTRIBUTE) {
        textMode = HTML.TEXTMODE.RCDATA;
      }
      var parserOptions = {
        getSpecialTag: TemplateTag.parseCompleteTag,
        shouldStop: isAtBlockCloseOrElse,
        textMode: textMode
      };
    result.content = HTMLTools.parseFragment(scanner, parserOptions);

    if (scanner.rest().slice(0, 2) !== '{{')
      scanner.fatal("Expected {{else}} or block close for " + blockName);

    var lastPos = scanner.pos; // save for error messages
    var tmplTag = TemplateTag.parse(scanner); // {{else}} or {{/foo}}

    if (tmplTag.type === 'ELSE') {
      // parse {{else}} and content up to close tag
      result.elseContent = HTMLTools.parseFragment(scanner, parserOptions);

      if (scanner.rest().slice(0, 2) !== '{{')
        scanner.fatal("Expected block close for " + blockName);

      lastPos = scanner.pos;
      tmplTag = TemplateTag.parse(scanner);
    }

    if (tmplTag.type === 'BLOCKCLOSE') {
      var blockName2 = tmplTag.path.join(',');
      if (blockName !== blockName2) {
        scanner.pos = lastPos;
        scanner.fatal('Expected tag to close ' + blockName + ', found ' +
                      blockName2);
      }
    } else {
      scanner.pos = lastPos;
      scanner.fatal('Expected tag to close ' + blockName + ', found ' +
                    tmplTag.type);
    }
  }

  var finalPos = scanner.pos;
  scanner.pos = startPos;
  validateTag(result, scanner);
  scanner.pos = finalPos;

  return result;
};

var isAtBlockCloseOrElse = function (scanner) {
  // Detect `{{else}}` or `{{/foo}}`.
  //
  // We do as much work ourselves before deferring to `TemplateTag.peek`,
  // for efficiency (we're called for every input token) and to be
  // less obtrusive, because `TemplateTag.peek` will throw an error if it
  // sees `{{` followed by a malformed tag.
  var rest, type;
  return (scanner.peek() === '{' &&
          (rest = scanner.rest()).slice(0, 2) === '{{' &&
          /^\{\{\s*(\/|else\b)/.test(rest) &&
          (type = TemplateTag.peek(scanner).type) &&
          (type === 'BLOCKCLOSE' || type === 'ELSE'));
};

// Validate that `templateTag` is correctly formed and legal for its
// HTML position.  Use `scanner` to report errors. On success, does
// nothing.
var validateTag = function (ttag, scanner) {

  if (ttag.type === 'INCLUSION' || ttag.type === 'BLOCKOPEN') {
    var args = ttag.args;
    if (args.length > 1 && args[0].length === 2 && args[0][0] !== 'PATH') {
      // we have a positional argument that is not a PATH followed by
      // other arguments
      scanner.fatal("First argument must be a function, to be called on the rest of the arguments; found " + args[0][0]);
    }
  }

  var position = ttag.position || TEMPLATE_TAG_POSITION.ELEMENT;
  if (position === TEMPLATE_TAG_POSITION.IN_ATTRIBUTE) {
    if (ttag.type === 'DOUBLE') {
      return;
    } else if (ttag.type === 'BLOCKOPEN') {
      var path = ttag.path;
      var path0 = path[0];
      if (! (path.length === 1 && (path0 === 'if' ||
                                   path0 === 'unless' ||
                                   path0 === 'with' ||
                                   path0 === 'each'))) {
        scanner.fatal("Custom block helpers are not allowed in an HTML attribute, only built-in ones like #each and #if");
      }
    } else {
      scanner.fatal(ttag.type + " template tag is not allowed in an HTML attribute");
    }
  } else if (position === TEMPLATE_TAG_POSITION.IN_START_TAG) {
    if (! (ttag.type === 'DOUBLE')) {
      scanner.fatal("Reactive HTML attributes must either have a constant name or consist of a single {{helper}} providing a dictionary of names and values.  A template tag of type " + ttag.type + " is not allowed here.");
    }
    if (scanner.peek() === '=') {
      scanner.fatal("Template tags are not allowed in attribute names, only in attribute values or in the form of a single {{helper}} that evaluates to a dictionary of name=value pairs.");
    }
  }

};


}).call(this);






(function () {

                                                                                                        //



Spacebars.parse = function (input) {

  var tree = HTMLTools.parseFragment(
    input,
    { getSpecialTag: TemplateTag.parseCompleteTag });

  return tree;
};

// ============================================================
// Optimizer for optimizing HTMLjs into raw HTML string when
// it doesn't contain template tags.

var optimize = function (tree) {

  var pushRawHTML = function (array, html) {
    var N = array.length;
    if (N > 0 && (array[N-1] instanceof HTML.Raw)) {
      array[N-1] = HTML.Raw(array[N-1].value + html);
    } else {
      array.push(HTML.Raw(html));
    }
  };

  var isPureChars = function (html) {
    return (html.indexOf('&') < 0 && html.indexOf('<') < 0);
  };

  // Returns `null` if no specials are found in the array, so that the
  // parent can perform the actual optimization.  Otherwise, returns
  // an array of parts which have been optimized as much as possible.
  // `forceOptimize` forces the latter case.
  var optimizeArrayParts = function (array, optimizePartsFunc, forceOptimize) {
    var result = null;
    if (forceOptimize)
      result = [];
    for (var i = 0, N = array.length; i < N; i++) {
      var part = optimizePartsFunc(array[i]);
      if (part !== null) {
        // something special found
        if (result === null) {
          // This is our first special item.  Stringify the other parts.
          result = [];
          for (var j = 0; j < i; j++)
            pushRawHTML(result, HTML.toHTML(array[j]));
        }
        result.push(part);
      } else {
        // just plain HTML found
        if (result !== null) {
          // we've already found something special, so convert this to Raw
          pushRawHTML(result, HTML.toHTML(array[i]));
        }
      }
    }
    if (result !== null) {
      // clean up unnecessary HTML.Raw wrappers around pure character data
      for (var j = 0; j < result.length; j++) {
        if ((result[j] instanceof HTML.Raw) &&
            isPureChars(result[j].value))
          // replace HTML.Raw with simple string
          result[j] = result[j].value;
      }
    }
    return result;
  };

  var doesAttributeValueHaveSpecials = function (v) {
    if (v instanceof HTMLTools.Special)
      return true;
    if (typeof v === 'function')
      return true;

    if (v instanceof Array) {
      for (var i = 0; i < v.length; i++)
        if (doesAttributeValueHaveSpecials(v[i]))
          return true;
      return false;
    }

    return false;
  };

  var optimizeParts = function (node) {
    // If we have nothing special going on, returns `null` (so that the
    // parent can optimize).  Otherwise returns a replacement for `node`
    // with optimized parts.
    if ((node == null) || (typeof node === 'string') ||
        (node instanceof HTML.CharRef) || (node instanceof HTML.Comment) ||
        (node instanceof HTML.Raw)) {
      // not special; let parent decide how whether to optimize
      return null;
    } else if (node instanceof HTML.Tag) {
      var tagName = node.tagName;
      if (tagName === 'textarea' ||
          (! (HTML.isKnownElement(tagName) &&
              ! HTML.isKnownSVGElement(tagName)))) {
        // optimizing into a TEXTAREA's RCDATA would require being a little
        // more clever.  foreign elements like SVG can't be stringified for
        // innerHTML.
        return node;
      }

      var mustOptimize = false;

      // Avoid ever producing HTML containing `<table><tr>...`, because the
      // browser will insert a TBODY.  If we just `createElement("table")` and
      // `createElement("tr")`, on the other hand, no TBODY is necessary
      // (assuming IE 8+).
      if (tagName === 'table')
        mustOptimize = true;

      if (node.attrs && ! mustOptimize) {
        var attrs = node.attrs;
        for (var k in attrs) {
          if (doesAttributeValueHaveSpecials(attrs[k])) {
            mustOptimize = true;
            break;
          }
        }
      }

      var newChildren = optimizeArrayParts(node.children, optimizeParts, mustOptimize);

      if (newChildren === null)
        return null;

      var newTag = HTML.getTag(node.tagName).apply(null, newChildren);
      newTag.attrs = node.attrs;

      return newTag;

    } else if (node instanceof Array) {
      return optimizeArrayParts(node, optimizeParts);
    } else {
      return node;
    }
  };

  var optTree = optimizeParts(tree);
  if (optTree !== null)
    // tree was optimized in parts
    return optTree;

  optTree = HTML.Raw(HTML.toHTML(tree));

  if (isPureChars(optTree.value))
    return optTree.value;

  return optTree;
};

// ============================================================
// Code-generation of template tags

var builtInBlockHelpers = {
  'if': 'UI.If',
  'unless': 'UI.Unless',
  'with': 'Spacebars.With',
  'each': 'UI.Each'
};

// These must be prefixed with `UI.` when you use them in a template.
var builtInLexicals = {
  'contentBlock': 'template.__content',
  'elseBlock': 'template.__elseContent'
};

// A "reserved name" can't be used as a <template> name.  This
// function is used by the template file scanner.
Spacebars.isReservedName = function (name) {
  return builtInBlockHelpers.hasOwnProperty(name);
};

var codeGenTemplateTag = function (tag) {
  if (tag.position === HTMLTools.TEMPLATE_TAG_POSITION.IN_START_TAG) {
    // only `tag.type === 'DOUBLE'` allowed (by earlier validation)
    return HTML.EmitCode('function () { return ' +
                         codeGenMustache(tag.path, tag.args, 'attrMustache')
                         + '; }');
  } else {
    if (tag.type === 'DOUBLE') {
      return HTML.EmitCode('function () { return ' +
                           codeGenMustache(tag.path, tag.args) + '; }');
    } else if (tag.type === 'TRIPLE') {
      return HTML.EmitCode('function () { return Spacebars.makeRaw(' +
                           codeGenMustache(tag.path, tag.args) + '); }');
    } else if (tag.type === 'INCLUSION' || tag.type === 'BLOCKOPEN') {
      var path = tag.path;

      if (tag.type === 'BLOCKOPEN' &&
          builtInBlockHelpers.hasOwnProperty(path[0])) {
        // if, unless, with, each.
        //
        // If someone tries to do `{{> if}}`, we don't
        // get here, but an error is thrown when we try to codegen the path.

        // Note: If we caught these errors earlier, while scanning, we'd be able to
        // provide nice line numbers.
        if (path.length > 1)
          throw new Error("Unexpected dotted path beginning with " + path[0]);
        if (! tag.args.length)
          throw new Error("#" + path[0] + " requires an argument");

        var codeParts = codeGenInclusionParts(tag);
        var dataFunc = codeParts.dataFunc; // must exist (tag.args.length > 0)
        var contentBlock = codeParts.content; // must exist
        var elseContentBlock = codeParts.elseContent; // may not exist

        var callArgs = [dataFunc, contentBlock];
        if (elseContentBlock)
          callArgs.push(elseContentBlock);

        return HTML.EmitCode(
          builtInBlockHelpers[path[0]] + '(' + callArgs.join(', ') + ')');

      } else {
        var compCode = codeGenPath(path, {lookupTemplate: true});

        if (path.length !== 1) {
          // path code may be reactive; wrap it
          compCode = 'function () { return ' + compCode + '; }';
        }

        var codeParts = codeGenInclusionParts(tag);
        var dataFunc = codeParts.dataFunc;
        var content = codeParts.content;
        var elseContent = codeParts.elseContent;

        var includeArgs = [compCode];
        if (content) {
          includeArgs.push(content);
          if (elseContent)
            includeArgs.push(elseContent);
        }

        var includeCode =
              'Spacebars.include(' + includeArgs.join(', ') + ')';

        if (dataFunc) {
          includeCode =
            'Spacebars.TemplateWith(' + dataFunc + ', UI.block(' +
            Spacebars.codeGen(HTML.EmitCode(includeCode)) + '))';
        }

        if (path[0] === 'UI' &&
            (path[1] === 'contentBlock' || path[1] === 'elseBlock')) {
          includeCode = 'UI.InTemplateScope(template, ' + includeCode + ')';
        }

        return HTML.EmitCode(includeCode);
      }
    } else {
      // Can't get here; TemplateTag validation should catch any
      // inappropriate tag types that might come out of the parser.
      throw new Error("Unexpected template tag type: " + tag.type);
    }
  }
};

var makeObjectLiteral = function (obj) {
  var parts = [];
  for (var k in obj)
    parts.push(toObjectLiteralKey(k) + ': ' + obj[k]);
  return '{' + parts.join(', ') + '}';
};

// `path` is an array of at least one string.
//
// If `path.length > 1`, the generated code may be reactive
// (i.e. it may invalidate the current computation).
//
// No code is generated to call the result if it's a function.
//
// Options:
//
// - lookupTemplate {Boolean} If true, generated code also looks in
//   the list of templates. (After helpers, before data context).
//   Used when generating code for `{{> foo}}` or `{{#foo}}`. Only
//   used for non-dotted paths.
var codeGenPath = function (path, opts) {
  if (builtInBlockHelpers.hasOwnProperty(path[0]))
    throw new Error("Can't use the built-in '" + path[0] + "' here");
  // Let `{{#if UI.contentBlock}}` check whether this template was invoked via
  // inclusion or as a block helper, in addition to supporting
  // `{{> UI.contentBlock}}`.
  if (path.length >= 2 &&
      path[0] === 'UI' && builtInLexicals.hasOwnProperty(path[1])) {
    if (path.length > 2)
      throw new Error("Unexpected dotted path beginning with " +
                      path[0] + '.' + path[1]);
    return builtInLexicals[path[1]];
  }

  var args = [toJSLiteral(path[0])];
  var lookupMethod = 'lookup';
  if (opts && opts.lookupTemplate && path.length === 1)
    lookupMethod = 'lookupTemplate';
  var code = 'self.' + lookupMethod + '(' + args.join(', ') + ')';

  if (path.length > 1) {
    code = 'Spacebars.dot(' + code + ', ' +
      _.map(path.slice(1), toJSLiteral).join(', ') + ')';
  }

  return code;
};

// Generates code for an `[argType, argValue]` argument spec,
// ignoring the third element (keyword argument name) if present.
//
// The resulting code may be reactive (in the case of a PATH of
// more than one element) and is not wrapped in a closure.
var codeGenArgValue = function (arg) {
  var argType = arg[0];
  var argValue = arg[1];

  var argCode;
  switch (argType) {
  case 'STRING':
  case 'NUMBER':
  case 'BOOLEAN':
  case 'NULL':
    argCode = toJSLiteral(argValue);
    break;
  case 'PATH':
    argCode = codeGenPath(argValue);
    break;
  default:
    // can't get here
    throw new Error("Unexpected arg type: " + argType);
  }

  return argCode;
};

// Generates a call to `Spacebars.fooMustache` on evaluated arguments.
// The resulting code has no function literals and must be wrapped in
// one for fine-grained reactivity.
var codeGenMustache = function (path, args, mustacheType) {
  var nameCode = codeGenPath(path);
  var argCode = codeGenMustacheArgs(args);
  var mustache = (mustacheType || 'mustache');

  return 'Spacebars.' + mustache + '(' + nameCode +
    (argCode ? ', ' + argCode.join(', ') : '') + ')';
};

// returns: array of source strings, or null if no
// args at all.
var codeGenMustacheArgs = function (tagArgs) {
  var kwArgs = null; // source -> source
  var args = null; // [source]

  // tagArgs may be null
  _.each(tagArgs, function (arg) {
    var argCode = codeGenArgValue(arg);

    if (arg.length > 2) {
      // keyword argument (represented as [type, value, name])
      kwArgs = (kwArgs || {});
      kwArgs[arg[2]] = argCode;
    } else {
      // positional argument
      args = (args || []);
      args.push(argCode);
    }
  });

  // put kwArgs in options dictionary at end of args
  if (kwArgs) {
    args = (args || []);
    args.push('Spacebars.kw(' + makeObjectLiteral(kwArgs) + ')');
  }

  return args;
};

// Takes an inclusion tag and returns an object containing these properties,
// all optional, whose values are JS source code:
//
// - `dataFunc` - source code of a data function literal
// - `content` - source code of a content block
// - `elseContent` - source code of an elseContent block
//
// Implements the calling convention for inclusions.
var codeGenInclusionParts = function (tag) {
  var ret = {};

  if ('content' in tag) {
    ret.content = (
      'UI.block(' + Spacebars.codeGen(tag.content) + ')');
  }
  if ('elseContent' in tag) {
    ret.elseContent = (
      'UI.block(' + Spacebars.codeGen(tag.elseContent) + ')');
  }

  var dataFuncCode = null;

  var args = tag.args;
  if (! args.length) {
    // e.g. `{{#foo}}`
    return ret;
  } else if (args[0].length === 3) {
    // keyword arguments only, e.g. `{{> point x=1 y=2}}`
    var dataProps = {};
    _.each(args, function (arg) {
      var argKey = arg[2];
      dataProps[argKey] = 'Spacebars.call(' + codeGenArgValue(arg) + ')';
    });
    dataFuncCode = makeObjectLiteral(dataProps);
  } else if (args[0][0] !== 'PATH') {
    // literal first argument, e.g. `{{> foo "blah"}}`
    //
    // tag validation has confirmed, in this case, that there is only
    // one argument (`args.length === 1`)
    dataFuncCode = codeGenArgValue(args[0]);
  } else if (args.length === 1) {
    // one argument, must be a PATH
    dataFuncCode = 'Spacebars.call(' + codeGenPath(args[0][1]) + ')';
  } else {
    dataFuncCode = codeGenMustache(args[0][1], args.slice(1),
                                   'dataMustache');
  }

  ret.dataFunc = 'function () { return ' + dataFuncCode + '; }';

  return ret;
};


// ============================================================
// Main compiler

var replaceSpecials = function (node) {
  if (node instanceof HTML.Tag) {
    // potential optimization: don't always create a new tag
    var newChildren = _.map(node.children, replaceSpecials);
    var newTag = HTML.getTag(node.tagName).apply(null, newChildren);
    var oldAttrs = node.attrs;
    var newAttrs = null;

    if (oldAttrs) {
      _.each(oldAttrs, function (value, name) {
        if (name.charAt(0) !== '$') {
          newAttrs = (newAttrs || {});
          newAttrs[name] = replaceSpecials(value);
        }
      });

      if (oldAttrs.$specials && oldAttrs.$specials.length) {
        newAttrs = (newAttrs || {});
        newAttrs.$dynamic = _.map(oldAttrs.$specials, function (special) {
          return codeGenTemplateTag(special.value);
        });
      }
    }

    newTag.attrs = newAttrs;
    return newTag;
  } else if (node instanceof Array) {
    return _.map(node, replaceSpecials);
  } else if (node instanceof HTMLTools.Special) {
    return codeGenTemplateTag(node.value);
  } else {
    return node;
  }
};

Spacebars.compile = function (input, options) {
  var tree = Spacebars.parse(input);
  return Spacebars.codeGen(tree, options);
};

Spacebars.codeGen = function (parseTree, options) {
  // is this a template, rather than a block passed to
  // a block helper, say
  var isTemplate = (options && options.isTemplate);

  var tree = parseTree;

  // The flags `isTemplate` and `isBody` are kind of a hack.
  if (isTemplate || (options && options.isBody)) {
    // optimizing fragments would require being smarter about whether we are
    // in a TEXTAREA, say.
    tree = optimize(tree);
  }

  tree = replaceSpecials(tree);

  var code = '(function () { var self = this; ';
  if (isTemplate) {
    // support `{{> UI.contentBlock}}` and `{{> UI.elseBlock}}` with
    // lexical scope by creating a local variable in the
    // template's render function.
    code += 'var template = this; ';
  }
  code += 'return ';
  code += HTML.toJS(tree);
  code += '; })';

  code = beautify(code);

  return code;
};

var beautify = function (code) {
  if (Package.minifiers && Package.minifiers.UglifyJSMinify) {
    var result = UglifyJSMinify(code,
                                { fromString: true,
                                  mangle: false,
                                  compress: false,
                                  output: { beautify: true,
                                            indent_level: 2,
                                            width: 80 } });
    var output = result.code;
    // Uglify interprets our expression as a statement and may add a semicolon.
    // Strip trailing semicolon.
    output = output.replace(/;$/, '');
    return output;
  } else {
    // don't actually beautify; no UglifyJS
    return code;
  }
};

// expose for compiler output tests
Spacebars._beautify = beautify;


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['spacebars-compiler'] = {};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var HTML = Package.htmljs.HTML;
var UI = Package.ui.UI;
var Handlebars = Package.ui.Handlebars;

/* Package-scope variables */
var Spacebars;

(function () {

                                                                                                            //
Spacebars = {};

// * `templateOrFunction` - template (component) or function returning a template
// or null
Spacebars.include = function (templateOrFunction, contentBlock, elseContentBlock) {
  if (contentBlock && ! UI.isComponent(contentBlock))
    throw new Error('Second argument to Spacebars.include must be a template or UI.block if present');
  if (elseContentBlock && ! UI.isComponent(elseContentBlock))
    throw new Error('Third argument to Spacebars.include must be a template or UI.block if present');

  var props = null;
  if (contentBlock) {
    props = (props || {});
    props.__content = contentBlock;
  }
  if (elseContentBlock) {
    props = (props || {});
    props.__elseContent = elseContentBlock;
  }

  if (UI.isComponent(templateOrFunction))
    return templateOrFunction.extend(props);

  var func = templateOrFunction;

  var f = function () {
    var emboxedFunc = UI.namedEmboxValue('Spacebars.include', func);
    f.stop = function () {
      emboxedFunc.stop();
    };
    var tmpl = emboxedFunc();

    if (tmpl === null)
      return null;
    if (! UI.isComponent(tmpl))
      throw new Error("Expected null or template in return value from inclusion function, found: " + tmpl);

    return tmpl.extend(props);
  };

  return f;
};

// Executes `{{foo bar baz}}` when called on `(foo, bar, baz)`.
// If `bar` and `baz` are functions, they are called before
// `foo` is called on them.
//
// This is the shared part of Spacebars.mustache and
// Spacebars.attrMustache, which differ in how they post-process the
// result.
Spacebars.mustacheImpl = function (value/*, args*/) {
  var args = arguments;
  // if we have any arguments (pos or kw), add an options argument
  // if there isn't one.
  if (args.length > 1) {
    var kw = args[args.length - 1];
    if (! (kw instanceof Spacebars.kw)) {
      kw = Spacebars.kw();
      // clone arguments into an actual array, then push
      // the empty kw object.
      args = Array.prototype.slice.call(arguments);
      args.push(kw);
    } else {
      // For each keyword arg, call it if it's a function
      var newHash = {};
      for (var k in kw.hash) {
        var v = kw.hash[k];
        newHash[k] = (typeof v === 'function' ? v() : v);
      }
      args[args.length - 1] = Spacebars.kw(newHash);
    }
  }

  return Spacebars.call.apply(null, args);
};

Spacebars.mustache = function (value/*, args*/) {
  var result = Spacebars.mustacheImpl.apply(null, arguments);

  if (result instanceof Spacebars.SafeString)
    return HTML.Raw(result.toString());
  else
    // map `null`, `undefined`, and `false` to null, which is important
    // so that attributes with nully values are considered absent.
    // stringify anything else (e.g. strings, booleans, numbers including 0).
    return (result == null || result === false) ? null : String(result);
};

Spacebars.attrMustache = function (value/*, args*/) {
  var result = Spacebars.mustacheImpl.apply(null, arguments);

  if (result == null || result === '') {
    return null;
  } else if (typeof result === 'object') {
    return result;
  } else if (typeof result === 'string' && HTML.isValidAttributeName(result)) {
    var obj = {};
    obj[result] = '';
    return obj;
  } else {
    throw new Error("Expected valid attribute name, '', null, or object");
  }
};

Spacebars.dataMustache = function (value/*, args*/) {
  var result = Spacebars.mustacheImpl.apply(null, arguments);

  return result;
};

// Idempotently wrap in `HTML.Raw`.
//
// Called on the return value from `Spacebars.mustache` in case the
// template uses triple-stache (`{{{foo bar baz}}}`).
Spacebars.makeRaw = function (value) {
  if (value == null) // null or undefined
    return null;
  else if (value instanceof HTML.Raw)
    return value;
  else
    return HTML.Raw(value);
};

// If `value` is a function, called it on the `args`, after
// evaluating the args themselves (by calling them if they are
// functions).  Otherwise, simply return `value` (and assert that
// there are no args).
Spacebars.call = function (value/*, args*/) {
  if (typeof value === 'function') {
    // evaluate arguments if they are functions (by calling them)
    var newArgs = [];
    for (var i = 1; i < arguments.length; i++) {
      var arg = arguments[i];
      newArgs[i-1] = (typeof arg === 'function' ? arg() : arg);
    }

    return value.apply(null, newArgs);
  } else {
    if (arguments.length > 1)
      throw new Error("Can't call non-function: " + value);

    return value;
  }
};

// Call this as `Spacebars.kw({ ... })`.  The return value
// is `instanceof Spacebars.kw`.
Spacebars.kw = function (hash) {
  if (! (this instanceof Spacebars.kw))
    // called without new; call with new
    return new Spacebars.kw(hash);

  this.hash = hash || {};
};

// Call this as `Spacebars.SafeString("some HTML")`.  The return value
// is `instanceof Spacebars.SafeString` (and `instanceof Handlebars.SafeString).
Spacebars.SafeString = function (html) {
  if (! (this instanceof Spacebars.SafeString))
    // called without new; call with new
    return new Spacebars.SafeString(html);

  return new Handlebars.SafeString(html);
};
Spacebars.SafeString.prototype = Handlebars.SafeString.prototype;

// `Spacebars.dot(foo, "bar", "baz")` performs a special kind
// of `foo.bar.baz` that allows safe indexing of `null` and
// indexing of functions (which calls the function).  If the
// result is a function, it is always a bound function (e.g.
// a wrapped version of `baz` that always uses `foo.bar` as
// `this`).
//
// In `Spacebars.dot(foo, "bar")`, `foo` is assumed to be either
// a non-function value or a "fully-bound" function wrapping a value,
// where fully-bound means it takes no arguments and ignores `this`.
//
// `Spacebars.dot(foo, "bar")` performs the following steps:
//
// * If `foo` is falsy, return `foo`.
//
// * If `foo` is a function, call it (set `foo` to `foo()`).
//
// * If `foo` is falsy now, return `foo`.
//
// * Return `foo.bar`, binding it to `foo` if it's a function.
Spacebars.dot = function (value, id1/*, id2, ...*/) {
  if (arguments.length > 2) {
    // Note: doing this recursively is probably less efficient than
    // doing it in an iterative loop.
    var argsForRecurse = [];
    argsForRecurse.push(Spacebars.dot(value, id1));
    argsForRecurse.push.apply(argsForRecurse,
                              Array.prototype.slice.call(arguments, 2));
    return Spacebars.dot.apply(null, argsForRecurse);
  }

  if (typeof value === 'function')
    value = value();

  if (! value)
    return value; // falsy, don't index, pass through

  var result = value[id1];
  if (typeof result !== 'function')
    return result;
  // `value[id1]` (or `value()[id1]`) is a function.
  // Bind it so that when called, `value` will be placed in `this`.
  return function (/*arguments*/) {
    return result.apply(value, arguments);
  };
};

// Implement Spacebars's #with, which renders its else case (or nothing)
// if the argument is falsy.
Spacebars.With = function (argFunc, contentBlock, elseContentBlock) {
  return UI.Component.extend({
    init: function () {
      this.v = UI.emboxValue(argFunc, UI.safeEquals);
    },
    render: function () {
      return UI.If(this.v, UI.With(this.v, contentBlock), elseContentBlock);
    },
    materialized: (function () {
      var f = function () {
        var self = this;
        if (Deps.active) {
          Deps.onInvalidate(function () {
            self.v.stop();
          });
        }
      };
      f.isWith = true;
      return f;
    })()
  });
};

Spacebars.TemplateWith = function (argFunc, contentBlock) {
  var w = UI.With(argFunc, contentBlock);
  w.__isTemplateWith = true;
  return w;
};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.spacebars = {
  Spacebars: Spacebars
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var UI = Package.ui.UI;
var Handlebars = Package.ui.Handlebars;
var HTML = Package.htmljs.HTML;

/* Package-scope variables */
var Template;

(function () {

                                                                                                                      //
// Create an empty template object. Packages and apps add templates on
// to this object.
Template = {};

Template.__define__ = function (templateName, renderFunc) {
  if (Template.hasOwnProperty(templateName))
    throw new Error("There are multiple templates named '" + templateName + "'. Each template needs a unique name.");

  Template[templateName] = UI.Component.extend({
    kind: "Template_" + templateName,
    render: renderFunc,
    __helperHost: true
  });
};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.templating = {
  Template: Template
};

})();



(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var $ = Package.jquery.$;
var jQuery = Package.jquery.jQuery;
var Deps = Package.deps.Deps;
var Random = Package.random.Random;
var EJSON = Package.ejson.EJSON;
var _ = Package.underscore._;
var OrderedDict = Package['ordered-dict'].OrderedDict;
var LocalCollection = Package.minimongo.LocalCollection;
var Minimongo = Package.minimongo.Minimongo;
var ObserveSequence = Package['observe-sequence'].ObserveSequence;
var HTML = Package.htmljs.HTML;

/* Package-scope variables */
var UI, Handlebars, reportUIException, _extend, Component, findComponentWithProp, findComponentWithHelper, getComponentData, updateTemplateInstance, AttributeHandler, makeAttributeHandler, ElementAttributesUpdater;

(function () {

                                                                                                        //

var debugFunc;

// Meteor UI calls into user code in many places, and it's nice to catch exceptions
// propagated from user code immediately so that the whole system doesn't just
// break.  Catching exceptions is easy; reporting them is hard.  This helper
// reports exceptions.
//
// Usage:
//
// ```
// try {
//   // ... someStuff ...
// } catch (e) {
//   reportUIException(e);
// }
// ```
//
// An optional second argument overrides the default message.

reportUIException = function (e, msg) {
  if (! debugFunc)
    // adapted from Deps
    debugFunc = function () {
      return (typeof Meteor !== "undefined" ? Meteor._debug :
              ((typeof console !== "undefined") && console.log ? console.log :
               function () {}));
    };

  // In Chrome, `e.stack` is a multiline string that starts with the message
  // and contains a stack trace.  Furthermore, `console.log` makes it clickable.
  // `console.log` supplies the space between the two arguments.
  debugFunc()(msg || 'Exception in Meteor UI:', e.stack || e.message);
};


}).call(this);






(function () {

                                                                                                        //
UI = {};

// A very basic operation like Underscore's `_.extend` that
// copies `src`'s own, enumerable properties onto `tgt` and
// returns `tgt`.
_extend = function (tgt, src) {
  for (var k in src)
    if (src.hasOwnProperty(k))
      tgt[k] = src[k];
  return tgt;
};

// Defines a single non-enumerable, read-only property
// on `tgt`.
// It won't be non-enumerable in IE 8, so its
// non-enumerability can't be relied on for logic
// purposes, it just makes things prettier in
// the dev console.
var _defineNonEnum = function (tgt, name, value) {
  try {
    Object.defineProperty(tgt, name, {value: value});
  } catch (e) {
    // IE < 9
    tgt[name] = value;
  }
  return tgt;
};

// Named function (like `function Component() {}` below) make
// inspection in debuggers more descriptive. In IE, this sets the
// value of the `Component` var in the function scope in which it's
// executed. We already have a top-level `Component` var so we create
// a new function scope to not write it over in IE.
(function () {

  // Components and Component kinds are the same thing, just
  // objects; there are no constructor functions, no `new`,
  // and no `instanceof`.  A Component object is like a class,
  // until it is inited, at which point it becomes more like
  // an instance.
  //
  // `y = x.extend({ ...new props })` creates a new Component
  // `y` with `x` as its prototype, plus additional properties
  // on `y` itself.  `extend` is used both to subclass and to
  // create instances (and the hope is we can gloss over the
  // difference in the docs).
  UI.Component = (function (constr) {

    // Make sure the "class name" that Chrome infers for
    // UI.Component is "Component", and that
    // `new UI.Component._constr` (which is what `extend`
    // does) also produces objects whose inferred class
    // name is "Component".  Chrome's name inference rules
    // are a little mysterious, but a function name in
    // the source code (as in `function Component() {}`)
    // seems to be reliable and high precedence.
    var C = new constr;
    _defineNonEnum(C, '_constr', constr);
    _defineNonEnum(C, '_super', null);
    return C;
  })(function Component() {});
})();

_extend(UI, {
  nextGuid: 2, // Component is 1!

  isComponent: function (obj) {
    return obj && UI.isKindOf(obj, UI.Component);
  },
  // `UI.isKindOf(a, b)` where `a` and `b` are Components
  // (or kinds) asks if `a` is or descends from
  // (transitively extends) `b`.
  isKindOf: function (a, b) {
    while (a) {
      if (a === b)
        return true;
      a = a._super;
    }
    return false;
  },
  // use these to produce error messages for developers
  // (though throwing a more specific error message is
  // even better)
  _requireNotDestroyed: function (c) {
    if (c.isDestroyed)
      throw new Error("Component has been destroyed; can't perform this operation");
  },
  _requireInited: function (c) {
    if (! c.isInited)
      throw new Error("Component must be inited to perform this operation");
  },
  _requireDom: function (c) {
    if (! c.dom)
      throw new Error("Component must be built into DOM to perform this operation");
  }
});

Component = UI.Component;

_extend(UI.Component, {
  kind: "Component",
  guid: "1",
  dom: null,
  // Has this Component ever been inited?
  isInited: false,
  // Has this Component been destroyed?  Only inited Components
  // can be destroyed.
  isDestroyed: false,
  // Component that created this component (typically also
  // the DOM containment parent).
  // No child pointers (except in `dom`).
  parent: null,

  // create a new subkind or instance whose proto pointer
  // points to this, with additional props set.
  extend: function (props) {
    // this function should never cause `props` to be
    // mutated in case people want to reuse `props` objects
    // in a mixin-like way.

    if (this.isInited)
      // Disallow extending inited Components so that
      // inited Components don't inherit instance-specific
      // properties from other inited Components, just
      // default values.
      throw new Error("Can't extend an inited Component");

    var constr;
    var constrMade = false;
    if (props && props.kind) {
      // If `kind` is different from super, set a constructor.
      // We used to set the function name here so that components
      // printed better in the console, but we took it out because
      // of CSP (and in hopes that Chrome finally adds proper
      // displayName support).
      constr = function () {};
      constrMade = true;
    } else {
      constr = this._constr;
    }

    // We don't know where we're getting `constr` from --
    // it might be from some supertype -- just that it has
    // the right function name.  So set the `prototype`
    // property each time we use it as a constructor.
    constr.prototype = this;

    var c = new constr;
    if (constrMade)
      c._constr = constr;

    if (props)
      _extend(c, props);

    // for efficient Component instantiations, we assign
    // as few things as possible here.
    _defineNonEnum(c, '_super', this);
    c.guid = String(UI.nextGuid++);

    return c;
  }
});

//callChainedCallback = function (comp, propName, orig) {
  // Call `comp.foo`, `comp._super.foo`,
  // `comp._super._super.foo`, and so on, but in reverse
  // order, and only if `foo` is an "own property" in each
  // case.  Furthermore, the passed value of `this` should
  // remain `comp` for all calls (which is achieved by
  // filling in `orig` when recursing).
//  if (comp._super)
//    callChainedCallback(comp._super, propName, orig || comp);
//
//  if (comp.hasOwnProperty(propName))
//    comp[propName].call(orig || comp);
//};


// Returns 0 if the nodes are the same or either one contains the other;
// otherwise, -1 if a comes before b, or else 1 if b comes before a in
// document order.
// Requires: `a` and `b` are element nodes in the same document tree.
var compareElementIndex = function (a, b) {
  // See http://ejohn.org/blog/comparing-document-position/
  if (a === b)
    return 0;
  if (a.compareDocumentPosition) {
    var n = a.compareDocumentPosition(b);
    return ((n & 0x18) ? 0 : ((n & 0x4) ? -1 : 1));
  } else {
    // Only old IE is known to not have compareDocumentPosition (though Safari
    // originally lacked it).  Thankfully, IE gives us a way of comparing elements
    // via the "sourceIndex" property.
    if (a.contains(b) || b.contains(a))
      return 0;
    return (a.sourceIndex < b.sourceIndex ? -1 : 1);
  }
};

findComponentWithProp = function (id, comp) {
  while (comp) {
    if (typeof comp[id] !== 'undefined')
      return comp;
    comp = comp.parent;
  }
  return null;
};

findComponentWithHelper = function (id, comp) {
  while (comp) {
    if (comp.__helperHost) {
      if (typeof comp[id] !== 'undefined')
        return comp;
      else
        return null;
    }
    comp = comp.parent;
  }
  return null;
};

getComponentData = function (comp) {
  comp = findComponentWithProp('data', comp);
  return (comp ?
          (typeof comp.data === 'function' ?
           comp.data() : comp.data) :
          null);
};

updateTemplateInstance = function (comp) {
  // Populate `comp.templateInstance.{firstNode,lastNode,data}`
  // on demand.
  var tmpl = comp.templateInstance;
  tmpl.data = getComponentData(comp);

  if (comp.dom && !comp.isDestroyed) {
    tmpl.firstNode = comp.dom.startNode().nextSibling;
    tmpl.lastNode = comp.dom.endNode().previousSibling;
    // Catch the case where the DomRange is empty and we'd
    // otherwise pass the out-of-order nodes (end, start)
    // as (firstNode, lastNode).
    if (tmpl.lastNode && tmpl.lastNode.nextSibling === tmpl.firstNode)
      tmpl.lastNode = tmpl.firstNode;
  } else {
    // on 'created' or 'destroyed' callbacks we don't have a DomRange
    tmpl.firstNode = null;
    tmpl.lastNode = null;
  }
};

_extend(UI.Component, {
  // We implement the old APIs here, including how data is passed
  // to helpers in `this`.
  helpers: function (dict) {
    _extend(this, dict);
  },
  events: function (dict) {
    var events;
    if (this.hasOwnProperty('_events'))
      events = this._events;
    else
      events = (this._events = []);

    _.each(dict, function (handler, spec) {
      var clauses = spec.split(/,\s+/);
      // iterate over clauses of spec, e.g. ['click .foo', 'click .bar']
      _.each(clauses, function (clause) {
        var parts = clause.split(/\s+/);
        if (parts.length === 0)
          return;

        var newEvents = parts.shift();
        var selector = parts.join(' ');
        events.push({events: newEvents,
                     selector: selector,
                     handler: handler});
      });
    });
  }
});

// XXX we don't really want this to be a user-visible callback,
// it's just a particular signal we need from DomRange.
UI.Component.notifyParented = function () {
  var self = this;
  for (var comp = self; comp; comp = comp._super) {
    var events = (comp.hasOwnProperty('_events') && comp._events) || null;
    if ((! events) && comp.hasOwnProperty('events') &&
        typeof comp.events === 'object') {
      // Provide limited back-compat support for `.events = {...}`
      // syntax.  Pass `comp.events` to the original `.events(...)`
      // function.  This code must run only once per component, in
      // order to not bind the handlers more than once, which is
      // ensured by the fact that we only do this when `comp._events`
      // is falsy, and we cause it to be set now.
      UI.Component.events.call(comp, comp.events);
      events = comp._events;
    }
    _.each(events, function (esh) { // {events, selector, handler}
      // wrap the handler here, per instance of the template that
      // declares the event map, so we can pass the instance to
      // the event handler.
      var wrappedHandler = function (event) {
        var comp = UI.DomRange.getContainingComponent(event.currentTarget);
        var data = comp && getComponentData(comp);
        var args = _.toArray(arguments);
        updateTemplateInstance(self);
        return Deps.nonreactive(function () {
          // put self.templateInstance as the second argument
          args.splice(1, 0, self.templateInstance);
          // Don't want to be in a deps context, even if we were somehow
          // triggered synchronously in an existing deps context
          // (the `blur` event can do this).
          // XXX we should probably do what Spark did and block all
          // event handling during our DOM manip.  Many apps had weird
          // unanticipated bugs until we did that.
          return esh.handler.apply(data === null ? {} : data, args);
        });
      };

      self.dom.on(esh.events, esh.selector, wrappedHandler);
    });
  }

  if (self.rendered) {
    // Defer rendered callback until flush time.
    Deps.afterFlush(function () {
      if (! self.isDestroyed) {
        updateTemplateInstance(self);
        self.rendered.call(self.templateInstance);
      }
    });
  }
};

// past compat
UI.Component.preserve = function () {
  Meteor._debug("The 'preserve' method on templates is now unnecessary and deprecated.");
};

// Gets the data context of the enclosing component that rendered a
// given element
UI.getElementData = function (el) {
  var comp = UI.DomRange.getContainingComponent(el);
  return comp && getComponentData(comp);
};

var jsUrlsAllowed = false;
UI._allowJavascriptUrls = function () {
  jsUrlsAllowed = true;
};
UI._javascriptUrlsAllowed = function () {
  return jsUrlsAllowed;
};


}).call(this);






(function () {

                                                                                                        //
if (Meteor.isClient) {

  // XXX in the future, make the jQuery adapter a separate
  // package and make the choice of back-end library
  // configurable.  Adapters all expose the same DomBackend interface.

  if (! Package.jquery)
    throw new Error("Meteor UI jQuery adapter: jQuery not found.");

  var $jq = Package.jquery.jQuery;

  var DomBackend = {};
  UI.DomBackend = DomBackend;

  ///// Removal detection and interoperability.

  // For an explanation of this technique, see:
  // http://bugs.jquery.com/ticket/12213#comment:23 .
  //
  // In short, an element is considered "removed" when jQuery
  // cleans up its *private* userdata on the element,
  // which we can detect using a custom event with a teardown
  // hook.

  var JQUERY_REMOVAL_WATCHER_EVENT_NAME = 'meteor_ui_removal_watcher';
  var REMOVAL_CALLBACKS_PROPERTY_NAME = '$meteor_ui_removal_callbacks';
  var NOOP = function () {};

  // Causes `elem` (a DOM element) to be detached from its parent, if any.
  // Whether or not `elem` was detached, causes any callbacks registered
  // with `onRemoveElement` on `elem` and its descendants to fire.
  // Not for use on non-element nodes.
  //
  // This method is modeled after the behavior of jQuery's `$(elem).remove()`,
  // which causes teardown on the subtree being removed.
  DomBackend.removeElement = function (elem) {
    $jq(elem).remove();
  };

  // Registers a callback function to be called when the given element or
  // one of its ancestors is removed from the DOM via the backend library.
  // The callback function is called at most once, and it receives the element
  // in question as an argument.
  DomBackend.onRemoveElement = function (elem, func) {
    if (! elem[REMOVAL_CALLBACKS_PROPERTY_NAME]) {
      elem[REMOVAL_CALLBACKS_PROPERTY_NAME] = [];

      // Set up the event, only the first time.
      $jq(elem).on(JQUERY_REMOVAL_WATCHER_EVENT_NAME, NOOP);
    }

    elem[REMOVAL_CALLBACKS_PROPERTY_NAME].push(func);
  };

  $jq.event.special[JQUERY_REMOVAL_WATCHER_EVENT_NAME] = {
    teardown: function() {
      var elem = this;
      var callbacks = elem[REMOVAL_CALLBACKS_PROPERTY_NAME];
      if (callbacks) {
        for (var i = 0; i < callbacks.length; i++)
          callbacks[i](elem);
        elem[REMOVAL_CALLBACKS_PROPERTY_NAME] = null;
      }
    }
  };

  DomBackend.parseHTML = function (html) {
    // Return an array of nodes.
    //
    // jQuery does fancy stuff like creating an appropriate
    // container element and setting innerHTML on it, as well
    // as working around various IE quirks.
    return $jq.parseHTML(html) || [];
  };

  // Must use jQuery semantics for `context`, not
  // querySelectorAll's.  In other words, all the parts
  // of `selector` must be found under `context`.
  DomBackend.findBySelector = function (selector, context) {
    return $jq(selector, context);
  };

  DomBackend.newFragment = function (nodeArray) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < nodeArray.length; i++)
      frag.appendChild(nodeArray[i]);
    return frag;
  };

  // `selector` is non-null.  `type` is one type (but
  // may be in backend-specific form, e.g. have namespaces).
  // Order fired must be order bound.
  DomBackend.delegateEvents = function (elem, type, selector, handler) {
    $jq(elem).on(type, selector, handler);
  };

  DomBackend.undelegateEvents = function (elem, type, handler) {
    $jq(elem).off(type, handler);
  };

  DomBackend.bindEventCapturer = function (elem, type, selector, handler) {
    var $elem = $jq(elem);

    var wrapper = function (event) {
      event = $jq.event.fix(event);
      event.currentTarget = event.target;

      // Note: It might improve jQuery interop if we called into jQuery
      // here somehow.  Since we don't use jQuery to dispatch the event,
      // we don't fire any of jQuery's event hooks or anything.  However,
      // since jQuery can't bind capturing handlers, it's not clear
      // where we would hook in.  Internal jQuery functions like `dispatch`
      // are too high-level.
      var $target = $jq(event.currentTarget);
      if ($target.is($elem.find(selector)))
        handler.call(elem, event);
    };

    handler._meteorui_wrapper = wrapper;

    type = this.parseEventType(type);
    // add *capturing* event listener
    elem.addEventListener(type, wrapper, true);
  };

  DomBackend.unbindEventCapturer = function (elem, type, handler) {
    type = this.parseEventType(type);
    elem.removeEventListener(type, handler._meteorui_wrapper, true);
  };

  DomBackend.parseEventType = function (type) {
    // strip off namespaces
    var dotLoc = type.indexOf('.');
    if (dotLoc >= 0)
      return type.slice(0, dotLoc);
    return type;
  };

}

}).call(this);






(function () {

                                                                                                        //
// TODO
// - Lazy removal detection
// - UI hooks (expose, test)
// - Quick remove/add (mark "leaving" members; needs UI hooks)
// - Event removal on removal

var DomBackend = UI.DomBackend;

var removeNode = function (n) {
//  if (n.nodeType === 1 &&
//      n.parentNode.$uihooks && n.parentNode.$uihooks.removeElement)
//    n.parentNode.$uihooks.removeElement(n);
//  else
    n.parentNode.removeChild(n);
};

var insertNode = function (n, parent, next) {
//  if (n.nodeType === 1 &&
//      parent.$uihooks && parent.$uihooks.insertElement)
//    parent.$uihooks.insertElement(n, parent, next);
//  else
    // `|| null` because IE throws an error if 'next' is undefined
  parent.insertBefore(n, next || null);
};

var moveNode = function (n, parent, next) {
//  if (n.nodeType === 1 &&
//      parent.$uihooks && parent.$uihooks.moveElement)
//    parent.$uihooks.moveElement(n, parent, next);
//  else
    // `|| null` because IE throws an error if 'next' is undefined
    parent.insertBefore(n, next || null);
};

// A very basic operation like Underscore's `_.extend` that
// copies `src`'s own, enumerable properties onto `tgt` and
// returns `tgt`.
var _extend = function (tgt, src) {
  for (var k in src)
    if (src.hasOwnProperty(k))
      tgt[k] = src[k];
  return tgt;
};

var _contains = function (list, item) {
  if (! list)
    return false;
  for (var i = 0, N = list.length; i < N; i++)
    if (list[i] === item)
      return true;
  return false;
};

var isArray = function (x) {
  return !!((typeof x.length === 'number') &&
            (x.sort || x.splice));
};

// Text nodes consisting of only whitespace
// are "insignificant" nodes.
var isSignificantNode = function (n) {
  return ! (n.nodeType === 3 &&
            (! n.nodeValue ||
             /^\s+$/.test(n.nodeValue)));
};

var checkId = function (id) {
  if (typeof id !== 'string')
    throw new Error("id must be a string");
  if (! id)
    throw new Error("id may not be empty");
};

var textExpandosSupported = (function () {
  var tn = document.createTextNode('');
  try {
    tn.blahblah = true;
    return true;
  } catch (e) {
    // IE 8
    return false;
  }
})();

var createMarkerNode = (
  textExpandosSupported ?
    function () { return document.createTextNode(""); } :
  function () { return document.createComment("IE"); });

var rangeParented = function (range) {
  if (! range.isParented) {
    range.isParented = true;

    if (! range.owner) {
      // top-level (unowned) ranges in an element,
      // keep a pointer to the range on the parent
      // element.  This is really just for IE 9+
      // TextNode GC issues, but we can't do reliable
      // feature detection (i.e. bug detection).
      var parentNode = range.parentNode();
      var rangeDict = (
        parentNode.$_uiranges ||
          (parentNode.$_uiranges = {}));
      rangeDict[range._rangeId] = range;
      range._rangeDict = rangeDict;

      // get jQuery to tell us when this node is removed
      DomBackend.onRemoveElement(parentNode, function () {
        rangeRemoved(range);
      });
    }

    if (range.component && range.component.notifyParented)
      range.component.notifyParented();

    // recurse on member ranges
    var members = range.members;
    for (var k in members) {
      var mem = members[k];
      if (mem instanceof DomRange)
        rangeParented(mem);
    }
  }
};

var rangeRemoved = function (range) {
  if (! range.isRemoved) {
    range.isRemoved = true;

    if (range._rangeDict)
      delete range._rangeDict[range._rangeId];

    // clean up events
    if (range.stopHandles) {
      for (var i = 0; i < range.stopHandles.length; i++)
        range.stopHandles[i].stop();
      range.stopHandles = null;
    }

    // notify component of removal
    if (range.removed)
      range.removed();

    membersRemoved(range);
  }
};

var nodeRemoved = function (node, viaBackend) {
  if (node.nodeType === 1) { // ELEMENT
    var comps = DomRange.getComponents(node);
    for (var i = 0, N = comps.length; i < N; i++)
      rangeRemoved(comps[i]);

    if (! viaBackend)
      DomBackend.removeElement(node);
  }
};

var membersRemoved = function (range) {
  var members = range.members;
  for (var k in members) {
    var mem = members[k];
    if (mem instanceof DomRange)
      rangeRemoved(mem);
    else
      nodeRemoved(mem);
  }
};

var nextGuid = 1;

var DomRange = function () {
  var start = createMarkerNode();
  var end = createMarkerNode();
  var fragment = DomBackend.newFragment([start, end]);
  fragment.$_uiIsOffscreen = true;

  this.start = start;
  this.end = end;
  start.$ui = this;
  end.$ui = this;

  this.members = {};
  this.nextMemberId = 1;
  this.owner = null;
  this._rangeId = nextGuid++;
  this._rangeDict = null;

  this.isParented = false;
  this.isRemoved = false;

  this.stopHandles = null;
};

_extend(DomRange.prototype, {
  getNodes: function () {
    if (! this.parentNode())
      return [];

    this.refresh();

    var afterNode = this.end.nextSibling;
    var nodes = [];
    for (var n = this.start;
         n && n !== afterNode;
         n = n.nextSibling)
      nodes.push(n);
    return nodes;
  },
  removeAll: function () {
    if (! this.parentNode())
      return;

    this.refresh();

    // leave start and end
    var afterNode = this.end;
    var nodes = [];
    for (var n = this.start.nextSibling;
         n && n !== afterNode;
         n = n.nextSibling) {
      // don't remove yet since then we'd lose nextSibling
      nodes.push(n);
    }
    for (var i = 0, N = nodes.length; i < N; i++)
      removeNode(nodes[i]);

    membersRemoved(this);

    this.members = {};
  },
  // (_nextNode is internal)
  add: function (id, newMemberOrArray, beforeId, _nextNode) {
    if (id != null && typeof id !== 'string') {
      if (typeof id !== 'object')
        // a non-object first argument is probably meant
        // as an id, NOT a new member, so complain about it
        // as such.
        throw new Error("id must be a string");
      beforeId = newMemberOrArray;
      newMemberOrArray = id;
      id = null;
    }

    if (! newMemberOrArray || typeof newMemberOrArray !== 'object')
      throw new Error("Expected component, node, or array");

    if (isArray(newMemberOrArray)) {
      if (newMemberOrArray.length === 1) {
        newMemberOrArray = newMemberOrArray[0];
      } else {
        if (id != null)
          throw new Error("Can only add one node or one component if id is given");
        var array = newMemberOrArray;
        // calculate `nextNode` once in case it involves a refresh
        _nextNode = this.getInsertionPoint(beforeId);
        for (var i = 0; i < array.length; i++)
          this.add(null, array[i], beforeId, _nextNode);
        return;
      }
    }

    var parentNode = this.parentNode();
    // Consider ourselves removed (and don't mind) if
    // start marker has no parent.
    if (! parentNode)
      return;
    // because this may call `refresh`, it must be done
    // early, before we add the new member.
    var nextNode = (_nextNode ||
                    this.getInsertionPoint(beforeId));

    var newMember = newMemberOrArray;
    if (id == null) {
      id = this.nextMemberId++;
    } else {
      checkId(id);
      id = ' ' + id;
    }

    var members = this.members;
    if (members.hasOwnProperty(id)) {
      var oldMember = members[id];
      if (oldMember instanceof DomRange) {
        // range, does it still exist?
        var oldRange = oldMember;
        if (oldRange.start.parentNode !== parentNode) {
          delete members[id];
          oldRange.owner = null;
          rangeRemoved(oldRange);
        } else {
          throw new Error("Member already exists: " + id.slice(1));
        }
      } else {
        // node, does it still exist?
        var oldNode = oldMember;
        if (oldNode.parentNode !== parentNode) {
          nodeRemoved(oldNode);
          delete members[id];
        } else {
          throw new Error("Member already exists: " + id.slice(1));
        }
      }
    }

    if (newMember instanceof DomRange) {
      // Range
      var range = newMember;
      range.owner = this;
      var nodes = range.getNodes();

      members[id] = newMember;
      for (var i = 0; i < nodes.length; i++)
        insertNode(nodes[i], parentNode, nextNode);

      if (this.isParented)
        rangeParented(range);
    } else {
      // Node
      if (typeof newMember.nodeType !== 'number')
        throw new Error("Expected Component or Node");
      var node = newMember;
      // can't attach `$ui` to a TextNode in IE 8, so
      // don't bother on any browser.
      if (node.nodeType !== 3)
        node.$ui = this;

      members[id] = newMember;
      insertNode(node, parentNode, nextNode);
    }
  },
  remove: function (id) {
    if (id == null) {
      // remove self
      this.removeAll();
      removeNode(this.start);
      removeNode(this.end);
      this.owner = null;
      rangeRemoved(this);
      return;
    }

    checkId(id);
    id = ' ' + id;
    var members = this.members;
    var member = (members.hasOwnProperty(id) &&
                  members[id]);
    delete members[id];

    // Don't mind double-remove.
    if (! member)
      return;

    var parentNode = this.parentNode();
    // Consider ourselves removed (and don't mind) if
    // start marker has no parent.
    if (! parentNode)
      return;

    if (member instanceof DomRange) {
      // Range
      var range = member;
      range.owner = null;
      // Don't mind if range (specifically its start
      // marker) has been removed already.
      if (range.start.parentNode === parentNode)
        member.remove();
    } else {
      // Node
      var node = member;
      // Don't mind if node has been removed already.
      if (node.parentNode === parentNode)
        removeNode(node);
    }
  },
  moveBefore: function (id, beforeId) {
    var nextNode = this.getInsertionPoint(beforeId);
    checkId(id);
    id = ' ' + id;
    var members = this.members;
    var member =
          (members.hasOwnProperty(id) &&
           members[id]);
    // Don't mind if member doesn't exist.
    if (! member)
      return;

    var parentNode = this.parentNode();
    // Consider ourselves removed (and don't mind) if
    // start marker has no parent.
    if (! parentNode)
      return;

    if (member instanceof DomRange) {
      // Range
      var range = member;
      // Don't mind if range (specifically its start marker)
      // has been removed already.
      if (range.start.parentNode === parentNode) {
        range.refresh();
        var nodes = range.getNodes();
        for (var i = 0; i < nodes.length; i++)
          moveNode(nodes[i], parentNode, nextNode);
      }
    } else {
      // Node
      var node = member;
      moveNode(node, parentNode, nextNode);
    }
  },
  get: function (id) {
    checkId(id);
    id = ' ' + id;
    var members = this.members;
    if (members.hasOwnProperty(id))
      return members[id];
    return null;
  },
  parentNode: function () {
    return this.start.parentNode;
  },
  startNode: function () {
    return this.start;
  },
  endNode: function () {
    return this.end;
  },
  eachMember: function (nodeFunc, rangeFunc) {
    var members = this.members;
    var parentNode = this.parentNode();
    for (var k in members) {
      // mem is a component (hosting a Range) or a Node
      var mem = members[k];
      if (mem instanceof DomRange) {
        // Range
        var range = mem;
        if (range.start.parentNode === parentNode) {
          rangeFunc && rangeFunc(range); // still there
        } else {
          range.owner = null;
          delete members[k]; // gone
          rangeRemoved(range);
        }
      } else {
        // Node
        var node = mem;
        if (node.parentNode === parentNode) {
          nodeFunc && nodeFunc(node); // still there
        } else {
          delete members[k]; // gone
          nodeRemoved(node);
        }
      }
    }
  },

  ///////////// INTERNALS below this point, pretty much

  // The purpose of "refreshing" a DomRange is to
  // take into account any element removals or moves
  // that may have occurred, and to "fix" the start
  // and end markers before the entire range is moved
  // or removed so that they bracket the appropriate
  // content.
  //
  // For example, if a DomRange contains a single element
  // node, and this node is moved using jQuery, refreshing
  // the DomRange will look to the element as ground truth
  // and move the start/end markers around the element.
  // A refreshed DomRange's nodes may surround nodes from
  // sibling DomRanges (including their marker nodes)
  // until the sibling DomRange is refreshed.
  //
  // Specifically, `refresh` moves the `start`
  // and `end` nodes to immediate before the first,
  // and after the last, "significant" node the
  // DomRange contains, where a significant node
  // is any node except a whitespace-only text-node.
  // All member ranges are refreshed first.  Adjacent
  // insignificant member nodes are included between
  // `start` and `end` as well, but it's possible that
  // other insignificant nodes remain as siblings
  // elsewhere.  Nodes with no DomRange owner that are
  // found between this DomRange's nodes are adopted.
  //
  // Performing add/move/remove operations on an "each"
  // shouldn't require refreshing the entire each, just
  // the member in question.  (However, adding to the
  // end may require refreshing the whole "each";
  // see `getInsertionPoint`.  Adding multiple members
  // at once using `add(array)` is faster.
  refresh: function () {

    var parentNode = this.parentNode();
    if (! parentNode)
      return;

    // Using `eachMember`, do several things:
    // - Refresh all member ranges
    // - Count our members
    // - If there's only one, get that one
    // - Make a list of member TextNodes, which we
    //   can't detect with a `$ui` property because
    //   IE 8 doesn't allow user-defined properties
    //   on TextNodes.
    var someNode = null;
    var someRange = null;
    var numMembers = 0;
    var textNodes = null;
    this.eachMember(function (node) {
      someNode = node;
      numMembers++;
      if (node.nodeType === 3) {
        textNodes = (textNodes || []);
        textNodes.push(node);
      }
    }, function (range) {
      range.refresh();
      someRange = range;
      numMembers++;
    });

    var firstNode = null;
    var lastNode = null;

    if (numMembers === 0) {
      // don't scan for members
    } else if (numMembers === 1) {
      if (someNode) {
        firstNode = someNode;
        lastNode = someNode;
      } else if (someRange) {
        firstNode = someRange.start;
        lastNode = someRange.end;
      }
    } else {
      // This loop is O(childNodes.length), even if our members
      // are already consecutive.  This means refreshing just one
      // item in a list is technically order of the total number
      // of siblings, including in other list items.
      //
      // The root cause is we intentionally don't track the
      // DOM order of our members, so finding the first
      // and last in sibling order either involves a scan
      // or a bunch of calls to compareDocumentPosition.
      //
      // Fortunately, the common cases of zero and one members
      // are optimized.  Also, the scan is super-fast because
      // no work is done for unknown nodes.  It could be possible
      // to optimize this code further if it becomes a problem.
      for (var node = parentNode.firstChild;
           node; node = node.nextSibling) {

        var nodeOwner;
        if (node.$ui &&
            (nodeOwner = node.$ui) &&
            ((nodeOwner === this &&
              node !== this.start &&
              node !== this.end &&
              isSignificantNode(node)) ||
             (nodeOwner !== this &&
              nodeOwner.owner === this &&
              nodeOwner.start === node))) {
          // found a member range or node
          // (excluding "insignificant" empty text nodes,
          // which won't be moved by, say, jQuery)
          if (firstNode) {
            // if we've already found a member in our
            // scan, see if there are some easy ownerless
            // nodes to "adopt" by scanning backwards.
            for (var n = firstNode.previousSibling;
                 n && ! n.$ui;
                 n = n.previousSibling) {
              this.members[this.nextMemberId++] = n;
              // can't attach `$ui` to a TextNode in IE 8, so
              // don't bother on any browser.
              if (n.nodeType !== 3)
                n.$ui = this;
            }
          }
          if (node.$ui === this) {
            // Node
            firstNode = (firstNode || node);
            lastNode = node;
          } else {
            // Range
            // skip it and include its nodes in
            // firstNode/lastNode.
            firstNode = (firstNode || node);
            node = node.$ui.end;
            lastNode = node;
          }
        }
      }
    }
    if (firstNode) {
      // some member or significant node was found.
      // expand to include our insigificant member
      // nodes as well.
      for (var n;
           (n = firstNode.previousSibling) &&
           (n.$ui && n.$ui === this ||
            _contains(textNodes, n));)
        firstNode = n;
      for (var n;
           (n = lastNode.nextSibling) &&
           (n.$ui && n.$ui === this ||
            _contains(textNodes, n));)
        lastNode = n;
      // adjust our start/end pointers
      if (firstNode !== this.start)
        insertNode(this.start,
                   parentNode, firstNode);
      if (lastNode !== this.end)
        insertNode(this.end, parentNode,
                 lastNode.nextSibling);
    }
  },
  getInsertionPoint: function (beforeId) {
    var members = this.members;
    var parentNode = this.parentNode();

    if (! beforeId) {
      // Refreshing here is necessary if we want to
      // allow elements to move around arbitrarily.
      // If jQuery is used to reorder elements, it could
      // easily make our `end` pointer meaningless,
      // even though all our members continue to make
      // good reference points as long as they are refreshed.
      //
      // However, a refresh is expensive!  Let's
      // make the developer manually refresh if
      // elements are being re-ordered externally.
      return this.end;
    }

    checkId(beforeId);
    beforeId = ' ' + beforeId;
    var mem = members[beforeId];

    if (mem instanceof DomRange) {
      // Range
      var range = mem;
      if (range.start.parentNode === parentNode) {
        // still there
        range.refresh();
        return range.start;
      } else {
        range.owner = null;
        rangeRemoved(range);
      }
    } else {
      // Node
      var node = mem;
      if (node.parentNode === parentNode)
        return node; // still there
      else
        nodeRemoved(node);
    }

    // not there anymore
    delete members[beforeId];
    // no good position
    return this.end;
  }
});

DomRange.prototype.elements = function (intoArray) {
  intoArray = (intoArray || []);
  this.eachMember(function (node) {
    if (node.nodeType === 1)
      intoArray.push(node);
  }, function (range) {
    range.elements(intoArray);
  });
  return intoArray;
};

// XXX alias the below as `UI.refresh` and `UI.insert`

// In a real-life case where you need a refresh,
// you probably don't have easy
// access to the appropriate DomRange or component,
// just the enclosing element:
//
// ```
// {{#Sortable}}
//   <div>
//     {{#each}}
//       ...
// ```
//
// In this case, Sortable wants to call `refresh`
// on the div, not the each, so it would use this function.
DomRange.refresh = function (element) {
  var comps = DomRange.getComponents(element);

  for (var i = 0, N = comps.length; i < N; i++)
    comps[i].refresh();
};

DomRange.getComponents = function (element) {
  var topLevelComps = [];
  for (var n = element.firstChild;
       n; n = n.nextSibling) {
    if (n.$ui && n === n.$ui.start &&
        ! n.$ui.owner)
      topLevelComps.push(n.$ui);
  }
  return topLevelComps;
};

// `parentNode` must be an ELEMENT, not a fragment
DomRange.insert = function (range, parentNode, nextNode) {
  var nodes = range.getNodes();
  for (var i = 0; i < nodes.length; i++)
    insertNode(nodes[i], parentNode, nextNode);
  rangeParented(range);
};

DomRange.getContainingComponent = function (element) {
  while (element && ! element.$ui)
    element = element.parentNode;

  var range = (element && element.$ui);

  while (range) {
    if (range.component)
      return range.component;
    range = range.owner;
  }
  return null;
};

///// FIND BY SELECTOR

DomRange.prototype.contains = function (compOrNode) {
  if (! compOrNode)
    throw new Error("Expected Component or Node");

  var parentNode = this.parentNode();
  if (! parentNode)
    return false;

  var range;
  if (compOrNode instanceof DomRange) {
    // Component
    range = compOrNode;
    var pn = range.parentNode();
    if (! pn)
      return false;
    // If parentNode is different, it must be a node
    // we contain.
    if (pn !== parentNode)
      return this.contains(pn);
    if (range === this)
      return false; // don't contain self
    // Ok, `range` is a same-parent range to see if we
    // contain.
  } else {
    // Node
    var node = compOrNode;
    if (! elementContains(parentNode, node))
      return false;

    while (node.parentNode !== parentNode)
      node = node.parentNode;

    range = node.$ui;
  }

  // Now see if `range` is truthy and either `this`
  // or an immediate subrange

  while (range && range !== this)
    range = range.owner;

  return range === this;
};

DomRange.prototype.$ = function (selector) {
  var self = this;

  var parentNode = this.parentNode();
  if (! parentNode)
    throw new Error("Can't select in removed DomRange");

  // Strategy: Find all selector matches under parentNode,
  // then filter out the ones that aren't in this DomRange
  // using upwards pointers ($ui, owner, parentNode).  This is
  // asymptotically slow in the presence of O(N) sibling
  // content that is under parentNode but not in our range,
  // so if performance is an issue, the selector should be
  // run on a child element.

  // Since jQuery can't run selectors on a DocumentFragment,
  // we don't expect findBySelector to work.
  if (parentNode.nodeType === 11 /* DocumentFragment */ ||
      parentNode.$_uiIsOffscreen)
    throw new Error("Can't use $ on an offscreen component");

  var results = DomBackend.findBySelector(selector, parentNode);

  // We don't assume `results` has jQuery API; a plain array
  // should do just as well.  However, if we do have a jQuery
  // array, we want to end up with one also, so we use
  // `.filter`.


  // Function that selects only elements that are actually
  // in this DomRange, rather than simply descending from
  // `parentNode`.
  var filterFunc = function (elem) {
    // handle jQuery's arguments to filter, where the node
    // is in `this` and the index is the first argument.
    if (typeof elem === 'number')
      elem = this;

    return self.contains(elem);
  };

  if (! results.filter) {
    // not a jQuery array, and not a browser with
    // Array.prototype.filter (e.g. IE <9)
    var newResults = [];
    for (var i = 0; i < results.length; i++) {
      var x = results[i];
      if (filterFunc(x))
        newResults.push(x);
    }
    results = newResults;
  } else {
    // `results.filter` is either jQuery's or ECMAScript's `filter`
    results = results.filter(filterFunc);
  }

  return results;
};


///// EVENTS

// List of events to always delegate, never capture.
// Since jQuery fakes bubbling for certain events in
// certain browsers (like `submit`), we don't want to
// get in its way.
//
// We could list all known bubbling
// events here to avoid creating speculative capturers
// for them, but it would only be an optimization.
var eventsToDelegate = {
  blur: 1, change: 1, click: 1, focus: 1, focusin: 1,
  focusout: 1, reset: 1, submit: 1
};

var EVENT_MODE_TBD = 0;
var EVENT_MODE_BUBBLING = 1;
var EVENT_MODE_CAPTURING = 2;

var HandlerRec = function (elem, type, selector, handler, $ui) {
  this.elem = elem;
  this.type = type;
  this.selector = selector;
  this.handler = handler;
  this.$ui = $ui;

  this.mode = EVENT_MODE_TBD;

  // It's important that delegatedHandler be a different
  // instance for each handlerRecord, because its identity
  // is used to remove it.
  //
  // It's also important that the closure have access to
  // `this` when it is not called with it set.
  this.delegatedHandler = (function (h) {
    return function (evt) {
      if ((! h.selector) && evt.currentTarget !== evt.target)
        // no selector means only fire on target
        return;
      if (! h.$ui.contains(evt.currentTarget))
        return;
      return h.handler.apply(h.$ui, arguments);
    };
  })(this);

  // WHY CAPTURE AND DELEGATE: jQuery can't delegate
  // non-bubbling events, because
  // event capture doesn't work in IE 8.  However, there
  // are all sorts of new-fangled non-bubbling events
  // like "play" and "touchenter".  We delegate these
  // events using capture in all browsers except IE 8.
  // IE 8 doesn't support these events anyway.

  var tryCapturing = elem.addEventListener &&
        (! eventsToDelegate.hasOwnProperty(
          DomBackend.parseEventType(type)));

  if (tryCapturing) {
    this.capturingHandler = (function (h) {
      return function (evt) {
        if (h.mode === EVENT_MODE_TBD) {
          // must be first time we're called.
          if (evt.bubbles) {
            // this type of event bubbles, so don't
            // get called again.
            h.mode = EVENT_MODE_BUBBLING;
            DomBackend.unbindEventCapturer(
              h.elem, h.type, h.capturingHandler);
            return;
          } else {
            // this type of event doesn't bubble,
            // so unbind the delegation, preventing
            // it from ever firing.
            h.mode = EVENT_MODE_CAPTURING;
            DomBackend.undelegateEvents(
              h.elem, h.type, h.delegatedHandler);
          }
        }

        h.delegatedHandler(evt);
      };
    })(this);

  } else {
    this.mode = EVENT_MODE_BUBBLING;
  }
};

HandlerRec.prototype.bind = function () {
  // `this.mode` may be EVENT_MODE_TBD, in which case we bind both. in
  // this case, 'capturingHandler' is in charge of detecting the
  // correct mode and turning off one or the other handlers.
  if (this.mode !== EVENT_MODE_BUBBLING) {
    DomBackend.bindEventCapturer(
      this.elem, this.type, this.selector || '*',
      this.capturingHandler);
  }

  if (this.mode !== EVENT_MODE_CAPTURING)
    DomBackend.delegateEvents(
      this.elem, this.type,
      this.selector || '*', this.delegatedHandler);
};

HandlerRec.prototype.unbind = function () {
  if (this.mode !== EVENT_MODE_BUBBLING)
    DomBackend.unbindEventCapturer(this.elem, this.type,
                                   this.capturingHandler);

  if (this.mode !== EVENT_MODE_CAPTURING)
    DomBackend.undelegateEvents(this.elem, this.type,
                                this.delegatedHandler);
};


// XXX could write the form of arguments for this function
// in several different ways, including simply as an event map.
DomRange.prototype.on = function (events, selector, handler) {
  var parentNode = this.parentNode();
  if (! parentNode)
    // if we're not in the DOM, silently fail.
    return;
  // haven't been added yet; error
  if (parentNode.$_uiIsOffscreen)
    throw new Error("Can't bind events before DomRange is inserted");

  var eventTypes = [];
  events.replace(/[^ /]+/g, function (e) {
    eventTypes.push(e);
  });

  if (! handler && (typeof selector === 'function')) {
    // omitted `selector`
    handler = selector;
    selector = null;
  } else if (! selector) {
    // take `""` to `null`
    selector = null;
  }

  var newHandlerRecs = [];
  for (var i = 0, N = eventTypes.length; i < N; i++) {
    var type = eventTypes[i];

    var eventDict = parentNode.$_uievents;
    if (! eventDict)
      eventDict = (parentNode.$_uievents = {});

    var info = eventDict[type];
    if (! info) {
      info = eventDict[type] = {};
      info.handlers = [];
    }
    var handlerList = info.handlers;
    var handlerRec = new HandlerRec(
      parentNode, type, selector, handler, this);
    newHandlerRecs.push(handlerRec);
    handlerRec.bind();
    handlerList.push(handlerRec);
    // move handlers of enclosing ranges to end
    for (var r = this.owner; r; r = r.owner) {
      // r is an enclosing DomRange
      for (var j = 0, Nj = handlerList.length;
           j < Nj; j++) {
        var h = handlerList[j];
        if (h.$ui === r) {
          h.unbind();
          h.bind();
          handlerList.splice(j, 1); // remove handlerList[j]
          handlerList.push(h);
          j--; // account for removed handler
          Nj--; // don't visit appended handlers
        }
      }
    }
  }

  this.stopHandles = (this.stopHandles || []);
  this.stopHandles.push({
    // closes over just `parentNode` and `newHandlerRecs`
    stop: function () {
      var eventDict = parentNode.$_uievents;
      if (! eventDict)
        return;

      for (var i = 0; i < newHandlerRecs.length; i++) {
        var handlerToRemove = newHandlerRecs[i];
        var info = eventDict[handlerToRemove.type];
        if (! info)
          continue;
        var handlerList = info.handlers;
        for (var j = handlerList.length - 1; j >= 0; j--) {
          if (handlerList[j] === handlerToRemove) {
            handlerToRemove.unbind();
            handlerList.splice(j, 1); // remove handlerList[j]
          }
        }
      }
      newHandlerRecs.length = 0;
    }
  });
};

  // Returns true if element a contains node b and is not node b.
  var elementContains = function (a, b) {
    if (a.nodeType !== 1) // ELEMENT
      return false;
    if (a === b)
      return false;

    if (a.compareDocumentPosition) {
      return a.compareDocumentPosition(b) & 0x10;
    } else {
          // Should be only old IE and maybe other old browsers here.
          // Modern Safari has both functions but seems to get contains() wrong.
          // IE can't handle b being a text node.  We work around this
          // by doing a direct parent test now.
      b = b.parentNode;
      if (! (b && b.nodeType === 1)) // ELEMENT
        return false;
      if (a === b)
        return true;

      return a.contains(b);
    }
  };


UI.DomRange = DomRange;


}).call(this);






(function () {

                                                                                                        //

// An AttributeHandler object is responsible for updating a particular attribute
// of a particular element.  AttributeHandler subclasses implement
// browser-specific logic for dealing with particular attributes across
// different browsers.
//
// To define a new type of AttributeHandler, use
// `var FooHandler = AttributeHandler.extend({ update: function ... })`
// where the `update` function takes arguments `(element, oldValue, value)`.
// The `element` argument is always the same between calls to `update` on
// the same instance.  `oldValue` and `value` are each either `null` or
// a Unicode string of the type that might be passed to the value argument
// of `setAttribute` (i.e. not an HTML string with character references).
// When an AttributeHandler is installed, an initial call to `update` is
// always made with `oldValue = null`.  The `update` method can access
// `this.name` if the AttributeHandler class is a generic one that applies
// to multiple attribute names.
//
// AttributeHandlers can store custom properties on `this`, as long as they
// don't use the names `element`, `name`, `value`, and `oldValue`.
//
// AttributeHandlers can't influence how attributes appear in rendered HTML,
// only how they are updated after materialization as DOM.

AttributeHandler = function (name, value) {
  this.name = name;
  this.value = value;
};

AttributeHandler.prototype.update = function (element, oldValue, value) {
  if (value === null) {
    if (oldValue !== null)
      element.removeAttribute(this.name);
  } else {
    element.setAttribute(this.name, value);
  }
};

AttributeHandler.extend = function (options) {
  var curType = this;
  var subType = function AttributeHandlerSubtype(/*arguments*/) {
    AttributeHandler.apply(this, arguments);
  };
  subType.prototype = new curType;
  subType.extend = curType.extend;
  if (options)
    _.extend(subType.prototype, options);
  return subType;
};

// Extended below to support both regular and SVG elements
var BaseClassHandler = AttributeHandler.extend({
  update: function (element, oldValue, value) {
    if (!this.getCurrentValue || !this.setValue)
      throw new Error("Missing methods in subclass of 'BaseClassHandler'");

    var oldClasses = oldValue ? _.compact(oldValue.split(' ')) : [];
    var newClasses = value ? _.compact(value.split(' ')) : [];

    // the current classes on the element, which we will mutate.
    var classes = _.compact(this.getCurrentValue(element).split(' '));

    // optimize this later (to be asymptotically faster) if necessary
    for (var i = 0; i < oldClasses.length; i++) {
      var c = oldClasses[i];
      if (! _.contains(newClasses, c))
        classes = _.without(classes, c);
    }
    for (var i = 0; i < newClasses.length; i++) {
      var c = newClasses[i];
      if ((! _.contains(oldClasses, c)) &&
          (! _.contains(classes, c)))
        classes.push(c);
    }

    this.setValue(element, classes.join(' '));
  }
});

var ClassHandler = BaseClassHandler.extend({
  // @param rawValue {String}
  getCurrentValue: function (element) {
    return element.className;
  },
  setValue: function (element, className) {
    element.className = className;
  }
});

var SVGClassHandler = BaseClassHandler.extend({
  getCurrentValue: function (element) {
    return element.className.baseVal;
  },
  setValue: function (element, className) {
    element.setAttribute('class', className);
  }
});

var BooleanHandler = AttributeHandler.extend({
  update: function (element, oldValue, value) {
    var focused = this.focused(element);

    if (!focused) {
      var name = this.name;
      if (value == null) {
        if (oldValue != null)
          element[name] = false;
      } else {
        element[name] = true;
      }
    }
  },
  // is the element part of a control which is focused?
  focused: function (element) {
    if (element.tagName === 'INPUT') {
      return element === document.activeElement;

    } else if (element.tagName === 'OPTION') {
      // find the containing SELECT element, on which focus
      // is actually set
      var selectEl = element;
      while (selectEl && selectEl.tagName !== 'SELECT')
        selectEl = selectEl.parentNode;

      if (selectEl)
        return selectEl === document.activeElement;
      else
        return false;
    } else {
      throw new Error("Expected INPUT or OPTION element");
    }
  }
});

var ValueHandler = AttributeHandler.extend({
  update: function (element, oldValue, value) {
    var focused = (element === document.activeElement);

    if (!focused)
      element.value = value;
  }
});

// attributes of the type 'xlink:something' should be set using
// the correct namespace in order to work
var XlinkHandler = AttributeHandler.extend({
  update: function(element, oldValue, value) {
    var NS = 'http://www.w3.org/1999/xlink';
    if (value === null) {
      if (oldValue !== null)
        element.removeAttributeNS(NS, this.name);
    } else {
      element.setAttributeNS(NS, this.name, this.value);
    }
  }
});

// cross-browser version of `instanceof SVGElement`
var isSVGElement = function (elem) {
  return 'ownerSVGElement' in elem;
};

var isUrlAttribute = function (tagName, attrName) {
  // Compiled from http://www.w3.org/TR/REC-html40/index/attributes.html
  // and
  // http://www.w3.org/html/wg/drafts/html/master/index.html#attributes-1
  var urlAttrs = {
    FORM: ['action'],
    BODY: ['background'],
    BLOCKQUOTE: ['cite'],
    Q: ['cite'],
    DEL: ['cite'],
    INS: ['cite'],
    OBJECT: ['classid', 'codebase', 'data', 'usemap'],
    APPLET: ['codebase'],
    A: ['href'],
    AREA: ['href'],
    LINK: ['href'],
    BASE: ['href'],
    IMG: ['longdesc', 'src', 'usemap'],
    FRAME: ['longdesc', 'src'],
    IFRAME: ['longdesc', 'src'],
    HEAD: ['profile'],
    SCRIPT: ['src'],
    INPUT: ['src', 'usemap', 'formaction'],
    BUTTON: ['formaction'],
    BASE: ['href'],
    MENUITEM: ['icon'],
    HTML: ['manifest'],
    VIDEO: ['poster']
  };

  if (attrName === 'itemid') {
    return true;
  }

  var urlAttrNames = urlAttrs[tagName] || [];
  return _.contains(urlAttrNames, attrName);
};

// To get the protocol for a URL, we let the browser normalize it for
// us, by setting it as the href for an anchor tag and then reading out
// the 'protocol' property.
if (Meteor.isClient) {
  var anchorForNormalization = document.createElement('A');
}

var normalizeUrl = function (url) {
  if (Meteor.isClient) {
    anchorForNormalization.href = url;
    return anchorForNormalization.href;
  } else {
    throw new Error('normalizeUrl not implemented on the server');
  }
};

// UrlHandler is an attribute handler for all HTML attributes that take
// URL values. It disallows javascript: URLs, unless
// UI._allowJavascriptUrls() has been called. To detect javascript:
// urls, we set the attribute and then reads the attribute out of the
// DOM, in order to avoid writing our own URL normalization code. (We
// don't want to be fooled by ' javascript:alert(1)' or
// 'jAvAsCrIpT:alert(1)'.) In future, when the URL interface is more
// widely supported, we can use that, which will be
// cleaner.  https://developer.mozilla.org/en-US/docs/Web/API/URL
var origUpdate = AttributeHandler.prototype.update;
var UrlHandler = AttributeHandler.extend({
  update: function (element, oldValue, value) {
    var self = this;
    var args = arguments;

    if (UI._javascriptUrlsAllowed()) {
      origUpdate.apply(self, args);
    } else {
      var isJavascriptProtocol =
            (normalizeUrl(value).indexOf('javascript:') === 0);
      if (isJavascriptProtocol) {
        Meteor._debug("URLs that use the 'javascript:' protocol are not " +
                      "allowed in URL attribute values. " +
                      "Call UI._allowJavascriptUrls() " +
                      "to enable them.");
        origUpdate.apply(self, [element, oldValue, null]);
      } else {
        origUpdate.apply(self, args);
      }
    }
  }
});

// XXX make it possible for users to register attribute handlers!
makeAttributeHandler = function (elem, name, value) {
  // generally, use setAttribute but certain attributes need to be set
  // by directly setting a JavaScript property on the DOM element.
  if (name === 'class') {
    if (isSVGElement(elem)) {
      return new SVGClassHandler(name, value);
    } else {
      return new ClassHandler(name, value);
    }
  } else if ((elem.tagName === 'OPTION' && name === 'selected') ||
             (elem.tagName === 'INPUT' && name === 'checked')) {
    return new BooleanHandler(name, value);
  } else if ((elem.tagName === 'TEXTAREA' || elem.tagName === 'INPUT')
             && name === 'value') {
    // internally, TEXTAREAs tracks their value in the 'value'
    // attribute just like INPUTs.
    return new ValueHandler(name, value);
  } else if (name.substring(0,6) === 'xlink:') {
    return new XlinkHandler(name.substring(6), value);
  } else if (isUrlAttribute(elem.tagName, name)) {
    return new UrlHandler(name, value);
  } else {
    return new AttributeHandler(name, value);
  }

  // XXX will need one for 'style' on IE, though modern browsers
  // seem to handle setAttribute ok.
};


ElementAttributesUpdater = function (elem) {
  this.elem = elem;
  this.handlers = {};
};

// Update attributes on `elem` to the dictionary `attrs`, whose
// values are strings.
ElementAttributesUpdater.prototype.update = function(newAttrs) {
  var elem = this.elem;
  var handlers = this.handlers;

  for (var k in handlers) {
    if (! newAttrs.hasOwnProperty(k)) {
      // remove attributes (and handlers) for attribute names
      // that don't exist as keys of `newAttrs` and so won't
      // be visited when traversing it.  (Attributes that
      // exist in the `newAttrs` object but are `null`
      // are handled later.)
      var handler = handlers[k];
      var oldValue = handler.value;
      handler.value = null;
      handler.update(elem, oldValue, null);
      delete handlers[k];
    }
  }

  for (var k in newAttrs) {
    var handler = null;
    var oldValue;
    var value = newAttrs[k];
    if (! handlers.hasOwnProperty(k)) {
      if (value !== null) {
        // make new handler
        handler = makeAttributeHandler(elem, k, value);
        handlers[k] = handler;
        oldValue = null;
      }
    } else {
      handler = handlers[k];
      oldValue = handler.value;
    }
    if (oldValue !== value) {
      handler.value = value;
      handler.update(elem, oldValue, value);
      if (value === null)
        delete handlers[k];
    }
  }
};


}).call(this);






(function () {

                                                                                                        //

UI.Component.instantiate = function (parent) {
  var kind = this;

  // check arguments
  if (UI.isComponent(kind)) {
    if (kind.isInited)
      throw new Error("A component kind is required, not an instance");
  } else {
    throw new Error("Expected Component kind");
  }

  var inst = kind.extend(); // XXX args go here
  inst.isInited = true;

  // XXX messy to define this here
  inst.templateInstance = {
    findAll: function (selector) {
      // XXX check that `.dom` exists here?
      return inst.dom.$(selector);
    },
    find: function (selector) {
      var result = this.findAll(selector);
      return result[0] || null;
    },
    firstNode: null,
    lastNode: null,
    data: null,
    __component__: inst
  };
  inst.templateInstance.$ = inst.templateInstance.findAll;

  inst.parent = (parent || null);

  if (inst.init)
    inst.init();

  if (inst.created) {
    updateTemplateInstance(inst);
    inst.created.call(inst.templateInstance);
  }

  return inst;
};

UI.Component.render = function () {
  return null;
};

var Box = function (func, equals) {
  var self = this;

  self.func = func;
  self.equals = equals;

  self.curResult = null;

  self.dep = new Deps.Dependency;

  self.resultComputation = Deps.nonreactive(function () {
    return Deps.autorun(function (c) {
      var func = self.func;

      var newResult = func();

      if (! c.firstRun) {
        var equals = self.equals;
        var oldResult = self.curResult;

        if (equals ? equals(newResult, oldResult) :
            newResult === oldResult) {
          // same as last time
          return;
        }
      }

      self.curResult = newResult;
      self.dep.changed();
    });
  });
};

Box.prototype.stop = function () {
  this.resultComputation.stop();
};

Box.prototype.get = function () {
  if (Deps.active && ! this.resultComputation.stopped)
    this.dep.depend();

  return this.curResult;
};

// Takes a reactive function (call it `inner`) and returns a reactive function
// `outer` which is equivalent except in its reactive behavior.  Specifically,
// `outer` has the following two special properties:
//
// 1. Isolation:  An invocation of `outer()` only invalidates its context
//    when the value of `inner()` changes.  For example, `inner` may be a
//    function that gets one or more Session variables and calculates a
//    true/false value.  `outer` blocks invalidation signals caused by the
//    Session variables changing and sends a signal out only when the value
//    changes between true and false (in this example).  The value can be
//    of any type, and it is compared with `===` unless an `equals` function
//    is provided.
//
// 2. Value Sharing:  The `outer` function returned by `emboxValue` can be
//    shared between different contexts, for example by assigning it to an
//    object as a method that can be accessed at any time, such as by
//    different templates or different parts of a template.  No matter
//    how many times `outer` is called, `inner` is only called once until
//    it changes.  The most recent value is stored internally.
//
// Conceptually, an emboxed value is much like a Session variable which is
// kept up to date by an autorun.  Session variables provide storage
// (value sharing) and they don't notify their listeners unless a value
// actually changes (isolation).  The biggest difference is that such an
// autorun would never be stopped, and the Session variable would never be
// deleted even if it wasn't used any more.  An emboxed value, on the other
// hand, automatically stops computing when it's not being used, and starts
// again when called from a reactive context.  This means that when it stops
// being used, it can be completely garbage-collected.
//
// If a non-function value is supplied to `emboxValue` instead of a reactive
// function, then `outer` is still a function but it simply returns the value.
//
UI.emboxValue = function (funcOrValue, equals) {
  if (typeof funcOrValue === 'function') {

    var func = funcOrValue;
    var box = new Box(func, equals);

    var f = function () {
      return box.get();
    };

    f.stop = function () {
      box.stop();
    };

    return f;

  } else {
    var value = funcOrValue;
    var result = function () {
      return value;
    };
    result._isEmboxedConstant = true;
    return result;
  }
};


UI.namedEmboxValue = function (name, funcOrValue, equals) {
  if (! Deps.active) {
    var f = UI.emboxValue(funcOrValue, equals);
    f.stop();
    return f;
  }

  var c = Deps.currentComputation;
  if (! c[name])
    c[name] = UI.emboxValue(funcOrValue, equals);

  return c[name];
};


UI.insert = function (renderedTemplate, parentElement, nextNode) {
  if (! renderedTemplate.dom)
    throw new Error("Expected template rendered with UI.render");

  UI.DomRange.insert(renderedTemplate.dom, parentElement, nextNode);
};

// Insert a DOM node or DomRange into a DOM element or DomRange.
//
// One of three things happens depending on what needs to be inserted into what:
// - `range.add` (anything into DomRange)
// - `UI.DomRange.insert` (DomRange into element)
// - `elem.insertBefore` (node into element)
//
// The optional `before` argument is an existing node or id to insert before in
// the parent element or DomRange.
var insert = function (nodeOrRange, parent, before) {
  if (! parent)
    throw new Error("Materialization parent required");

  if (parent instanceof UI.DomRange) {
    parent.add(nodeOrRange, before);
  } else if (nodeOrRange instanceof UI.DomRange) {
    // parent is an element; inserting a range
    UI.DomRange.insert(nodeOrRange, parent, before);
  } else {
    // parent is an element; inserting an element
    parent.insertBefore(nodeOrRange, before || null); // `null` for IE
  }
};

UI.render = function (kind, parentComponent) {
  if (kind.isInited)
    throw new Error("Can't render component instance, only component kind");

  var inst, content, range;

  Deps.nonreactive(function () {

    inst = kind.instantiate(parentComponent);

    content = (inst.render && inst.render());

    range = new UI.DomRange;
    inst.dom = range;
    range.component = inst;

  });

  materialize(content, range, null, inst);

  range.removed = function () {
    inst.isDestroyed = true;
    if (inst.destroyed) {
      Deps.nonreactive(function () {
        updateTemplateInstance(inst);
        inst.destroyed.call(inst.templateInstance);
      });
    }
  };

  return inst;
};

UI.renderWithData = function (kind, data, parentComponent) {
  if (! UI.isComponent(kind))
    throw new Error("Component required here");
  if (kind.isInited)
    throw new Error("Can't render component instance, only component kind");
  if (typeof data === 'function')
    throw new Error("Data argument can't be a function");

  return UI.render(kind.extend({data: function () { return data; }}),
                   parentComponent);
};

var contentEquals = function (a, b) {
  if (a instanceof HTML.Raw) {
    return (b instanceof HTML.Raw) && (a.value === b.value);
  } else if (a == null) {
    return (b == null);
  } else {
    return (a === b) &&
      ((typeof a === 'number') || (typeof a === 'boolean') ||
       (typeof a === 'string'));
  }
};

UI.InTemplateScope = function (tmplInstance, content) {
  if (! (this instanceof UI.InTemplateScope))
    // called without `new`
    return new UI.InTemplateScope(tmplInstance, content);

  var parentPtr = tmplInstance.parent;
  if (parentPtr.__isTemplateWith)
    parentPtr = parentPtr.parent;

  this.parentPtr = parentPtr;
  this.content = content;
};

UI.InTemplateScope.prototype.toHTML = function (parentComponent) {
  return HTML.toHTML(this.content, this.parentPtr);
};

UI.InTemplateScope.prototype.toText = function (textMode, parentComponent) {
  return HTML.toText(this.content, textMode, this.parentPtr);
};

// Convert the pseudoDOM `node` into reactive DOM nodes and insert them
// into the element or DomRange `parent`, before the node or id `before`.
var materialize = function (node, parent, before, parentComponent) {
  // XXX should do more error-checking for the case where user is supplying the tags.
  // For example, check that CharRef has `html` and `str` properties and no content.
  // Check that Comment has a single string child and no attributes.  Etc.

  if (node == null) {
    // null or undefined.
    // do nothinge.
  } else if ((typeof node === 'string') || (typeof node === 'boolean') || (typeof node === 'number')) {
    node = String(node);
    insert(document.createTextNode(node), parent, before);
  } else if (node instanceof Array) {
    for (var i = 0; i < node.length; i++)
      materialize(node[i], parent, before, parentComponent);
  } else if (typeof node === 'function') {

    var range = new UI.DomRange;
    var lastContent = null;
    var rangeUpdater = Deps.autorun(function (c) {
      var content = node();
      // normalize content a little, for easier comparison
      if (HTML.isNully(content))
        content = null;
      else if ((content instanceof Array) && content.length === 1)
        content = content[0];

      // update if content is different from last time
      if (! contentEquals(content, lastContent)) {
        lastContent = content;

        if (! c.firstRun)
          range.removeAll();

        materialize(content, range, null, parentComponent);
      }
    });
    range.removed = function () {
      rangeUpdater.stop();
      if (node.stop)
        node.stop();
    };
    // XXXX HACK
    if (Deps.active && node.stop) {
      Deps.onInvalidate(function () {
        node.stop();
      });
    }
    insert(range, parent, before);
  } else if (node instanceof HTML.Tag) {
    var tagName = node.tagName;
    var elem;
    if (HTML.isKnownSVGElement(tagName) && document.createElementNS) {
      elem = document.createElementNS('http://www.w3.org/2000/svg', tagName);
    } else {
      elem = document.createElement(node.tagName);
    }

    var rawAttrs = node.attrs;
    var children = node.children;
    if (node.tagName === 'textarea') {
      rawAttrs = (rawAttrs || {});
      rawAttrs.value = children;
      children = [];
    };

    if (rawAttrs) {
      var attrComp = Deps.autorun(function (c) {
        var attrUpdater = c.updater;
        if (! attrUpdater) {
          attrUpdater = c.updater = new ElementAttributesUpdater(elem);
        }

        try {
          var attrs = HTML.evaluateAttributes(rawAttrs, parentComponent);
          var stringAttrs = {};
          if (attrs) {
            for (var k in attrs) {
              stringAttrs[k] = HTML.toText(attrs[k], HTML.TEXTMODE.STRING,
                                           parentComponent);
            }
            attrUpdater.update(stringAttrs);
          }
        } catch (e) {
          reportUIException(e);
        }
      });
      UI.DomBackend.onRemoveElement(elem, function () {
        attrComp.stop();
      });
    }
    materialize(children, elem, null, parentComponent);

    insert(elem, parent, before);
  } else if (typeof node.instantiate === 'function') {
    // component
    var instance = UI.render(node, parentComponent);

    // Call internal callback, which may take advantage of the current
    // Deps computation.
    if (instance.materialized)
      instance.materialized();

    insert(instance.dom, parent, before);
  } else if (node instanceof HTML.CharRef) {
    insert(document.createTextNode(node.str), parent, before);
  } else if (node instanceof HTML.Comment) {
    insert(document.createComment(node.sanitizedValue), parent, before);
  } else if (node instanceof HTML.Raw) {
    // Get an array of DOM nodes by using the browser's HTML parser
    // (like innerHTML).
    var htmlNodes = UI.DomBackend.parseHTML(node.value);
    for (var i = 0; i < htmlNodes.length; i++)
      insert(htmlNodes[i], parent, before);
  } else if (Package['html-tools'] && (node instanceof Package['html-tools'].HTMLTools.Special)) {
    throw new Error("Can't materialize Special tag, it's just an intermediate rep");
  } else if (node instanceof UI.InTemplateScope) {
    materialize(node.content, parent, before, node.parentPtr);
  } else {
    // can't get here
    throw new Error("Unexpected node in htmljs: " + node);
  }
};



// XXX figure out the right names, and namespace, for these.
// for example, maybe some of them go in the HTML package.
UI.materialize = materialize;

UI.body = UI.Component.extend({
  kind: 'body',
  contentParts: [],
  render: function () {
    return this.contentParts;
  },
  // XXX revisit how body works.
  INSTANTIATED: false,
  __helperHost: true
});

UI.block = function (renderFunc) {
  return UI.Component.extend({ render: renderFunc });
};

UI.toHTML = function (content, parentComponent) {
  return HTML.toHTML(content, parentComponent);
};

UI.toRawText = function (content, parentComponent) {
  return HTML.toText(content, HTML.TEXTMODE.STRING, parentComponent);
};


}).call(this);






(function () {

                                                                                                        //

UI.If = function (argFunc, contentBlock, elseContentBlock) {
  checkBlockHelperArguments('If', argFunc, contentBlock, elseContentBlock);

  var f = function () {
    var emboxedCondition = emboxCondition(argFunc);
    f.stop = function () {
      emboxedCondition.stop();
    };
    if (emboxedCondition())
      return contentBlock;
    else
      return elseContentBlock || null;
  };

  return f;
};


UI.Unless = function (argFunc, contentBlock, elseContentBlock) {
  checkBlockHelperArguments('Unless', argFunc, contentBlock, elseContentBlock);

  var f = function () {
    var emboxedCondition = emboxCondition(argFunc);
    f.stop = function () {
      emboxedCondition.stop();
    };
    if (! emboxedCondition())
      return contentBlock;
    else
      return elseContentBlock || null;
  };

  return f;
};

// Returns true if `a` and `b` are `===`, unless they are of a mutable type.
// (Because then, they may be equal references to an object that was mutated,
// and we'll never know.  We save only a reference to the old object; we don't
// do any deep-copying or diffing.)
UI.safeEquals = function (a, b) {
  if (a !== b)
    return false;
  else
    return ((!a) || (typeof a === 'number') || (typeof a === 'boolean') ||
            (typeof a === 'string'));
};

// Unlike Spacebars.With, there's no else case and no conditional logic.
//
// We don't do any reactive emboxing of `argFunc` here; it should be done
// by the caller if efficiency and/or number of calls to the data source
// is important.
UI.With = function (argFunc, contentBlock) {
  checkBlockHelperArguments('With', argFunc, contentBlock);

  var block = contentBlock;
  if ('data' in block) {
    // XXX TODO: get religion about where `data` property goes
    block = UI.block(function () {
      return contentBlock;
    });
  }

  block.data = function () {
    throw new Error("Can't get data for component kind");
  };

  block.init = function () {
    this.data = UI.emboxValue(argFunc, UI.safeEquals);
  };

  block.materialized = function () {
    var self = this;
    if (Deps.active) {
      Deps.onInvalidate(function () {
        self.data.stop();
      });
    }
  };
  block.materialized.isWith = true;

  return block;
};

UI.Each = function (argFunc, contentBlock, elseContentBlock) {
  checkBlockHelperArguments('Each', argFunc, contentBlock, elseContentBlock);

  return UI.EachImpl.extend({
    __sequence: argFunc,
    __content: contentBlock,
    __elseContent: elseContentBlock
  });
};

var checkBlockHelperArguments = function (which, argFunc, contentBlock, elseContentBlock) {
  if (typeof argFunc !== 'function')
    throw new Error('First argument to ' + which + ' must be a function');
  if (! UI.isComponent(contentBlock))
    throw new Error('Second argument to ' + which + ' must be a template or UI.block');
  if (elseContentBlock && ! UI.isComponent(elseContentBlock))
    throw new Error('Third argument to ' + which + ' must be a template or UI.block if present');
};

// Returns a function that computes `!! conditionFunc()` except:
//
// - Empty array is considered falsy
// - The result is UI.emboxValue'd (doesn't trigger invalidation
//   as long as the condition stays truthy or stays falsy)
var emboxCondition = function (conditionFunc) {
  return UI.namedEmboxValue('if/unless', function () {
    // `condition` is emboxed; it is always a function,
    // and it only triggers invalidation if its return
    // value actually changes.  We still need to isolate
    // the calculation of whether it is truthy or falsy
    // in order to not re-render if it changes from one
    // truthy or falsy value to another.
    var cond = conditionFunc();

    // empty arrays are treated as falsey values
    if (cond instanceof Array && cond.length === 0)
      return false;
    else
      return !! cond;
  });
};


}).call(this);






(function () {

                                                                                                        //
UI.EachImpl = Component.extend({
  typeName: 'Each',
  render: function (modeHint) {
    var self = this;
    var content = self.__content;
    var elseContent = self.__elseContent;

    if (modeHint === 'STATIC') {
      // This is a hack.  The caller gives us a hint if the
      // value we return will be static (in HTML or text)
      // or dynamic (materialized DOM).  The dynamic path
      // returns `null` and then we populate the DOM from
      // the `materialized` callback.
      //
      // It would be much cleaner to always return the same
      // value here, and to have that value be some special
      // object that encapsulates the logic for populating
      // the #each using a mode-agnostic interface that
      // works for HTML, text, and DOM.  Alternatively, we
      // could formalize the current pattern, e.g. defining
      // a method like component.populate(domRange) and one
      // like renderStatic() or even renderHTML / renderText.
      var parts = _.map(
        ObserveSequence.fetch(self.__sequence()),
        function (item) {
          return content.extend({data: function () {
            return item;
          }});
        });

      if (parts.length) {
        return parts;
      } else {
        return elseContent;
      }
      return parts;
    } else {
      return null;
    }
  },
  materialized: function () {
    var self = this;

    var range = self.dom;

    var content = self.__content;
    var elseContent = self.__elseContent;

    // if there is an else clause, keep track of the number of
    // rendered items.  use this to display the else clause when count
    // becomes zero, and remove it when count becomes positive.
    var itemCount = 0;
    var addToCount = function(delta) {
      if (!elseContent) // if no else, no need to keep track of count
        return;

      if (itemCount + delta < 0)
        throw new Error("count should never become negative");

      if (itemCount === 0) {
        // remove else clause
        range.removeAll();
      }
      itemCount += delta;
      if (itemCount === 0) {
        UI.materialize(elseContent, range, null, self);
      }
    };

    this.observeHandle = ObserveSequence.observe(function () {
      return self.__sequence();
    }, {
      addedAt: function (id, item, i, beforeId) {
        addToCount(1);
        id = LocalCollection._idStringify(id);

        var data = item;
        var dep = new Deps.Dependency;

        // function to become `comp.data`
        var dataFunc = function () {
          dep.depend();
          return data;
        };
        // Storing `$set` on `comp.data` lets us
        // access it from `changed`.
        dataFunc.$set = function (v) {
          data = v;
          dep.changed();
        };

        if (beforeId)
          beforeId = LocalCollection._idStringify(beforeId);

        var renderedItem = UI.render(content.extend({data: dataFunc}), self);
        range.add(id, renderedItem.dom, beforeId);
      },
      removedAt: function (id, item) {
        addToCount(-1);
        range.remove(LocalCollection._idStringify(id));
      },
      movedTo: function (id, item, i, j, beforeId) {
        range.moveBefore(
          LocalCollection._idStringify(id),
          beforeId && LocalCollection._idStringify(beforeId));
      },
      changedAt: function (id, newItem, atIndex) {
        range.get(LocalCollection._idStringify(id)).component.data.$set(newItem);
      }
    });

    // on initial render, display the else clause if no items
    addToCount(0);
  },
  destroyed: function () {
    if (this.__component__.observeHandle)
      this.__component__.observeHandle.stop();
  }
});


}).call(this);






(function () {

                                                                                                        //

var global = (function () { return this; })();

// Searches for the given property in `comp` or a parent,
// and returns it as is (without call it if it's a function).
var lookupComponentProp = function (comp, prop) {
  comp = findComponentWithProp(prop, comp);
  var result = (comp ? comp.data : null);
  if (typeof result === 'function')
    result = _.bind(result, comp);
  return result;
};

// Component that's a no-op when used as a block helper like
// `{{#foo}}...{{/foo}}`. Prints a warning that it is deprecated.
var noOpComponent = function (name) {
  return Component.extend({
    kind: 'NoOp',
    render: function () {
      Meteor._debug("{{#" + name + "}} is now unnecessary and deprecated.");
      return this.__content;
    }
  });
};

// This map is searched first when you do something like `{{#foo}}` in
// a template.
var builtInComponents = {
  // for past compat:
  'constant': noOpComponent("constant"),
  'isolate': noOpComponent("isolate")
};

_extend(UI.Component, {
  // Options:
  //
  // - template {Boolean} If true, look at the list of templates after
  //   helpers and before data context.
  lookup: function (id, opts) {
    var self = this;
    var template = opts && opts.template;
    var result;
    var comp;

    if (!id)
      throw new Error("must pass id to lookup");

    if (/^\./.test(id)) {
      // starts with a dot. must be a series of dots which maps to an
      // ancestor of the appropriate height.
      if (!/^(\.)+$/.test(id)) {
        throw new Error("id starting with dot must be a series of dots");
      }

      var compWithData = findComponentWithProp('data', self);
      for (var i = 1; i < id.length; i++) {
        compWithData = compWithData ? findComponentWithProp('data', compWithData.parent) : null;
      }

      return (compWithData ? compWithData.data : null);

    } else if ((comp = findComponentWithHelper(id, self))) {
      // found a property or method of a component
      // (`self` or one of its ancestors)
      var result = comp[id];

    } else if (_.has(builtInComponents, id)) {
      return builtInComponents[id];

    // Code to search the global namespace for capitalized names
    // like component classes, `Template`, `StringUtils.foo`,
    // etc.
    //
    // } else if (/^[A-Z]/.test(id) && (id in global)) {
    //   // Only look for a global identifier if `id` is
    //   // capitalized.  This avoids having `{{name}}` mean
    //   // `window.name`.
    //   result = global[id];
    //   return function (/*arguments*/) {
    //     var data = getComponentData(self);
    //     if (typeof result === 'function')
    //       return result.apply(data, arguments);
    //     return result;
    //   };
    } else if (template && _.has(Template, id)) {
      return Template[id];

    } else if ((result = UI._globalHelper(id))) {

    } else {
      // Resolve id `foo` as `data.foo` (with a "soft dot").
      return function (/*arguments*/) {
        var data = getComponentData(self);
        if (template && !(data && _.has(data, id)))
          throw new Error("Can't find template, helper or data context key: " + id);
        if (! data)
          return data;
        var result = data[id];
        if (typeof result === 'function')
          return result.apply(data, arguments);
        return result;
      };
    }

    if (typeof result === 'function' && ! result._isEmboxedConstant) {
      // Wrap the function `result`, binding `this` to `getComponentData(self)`.
      // This creates a dependency when the result function is called.
      // Don't do this if the function is really just an emboxed constant.
      return function (/*arguments*/) {
        var data = getComponentData(self);
        return result.apply(data === null ? {} : data, arguments);
      };
    } else {
      return result;
    };
  },
  lookupTemplate: function (id) {
    return this.lookup(id, {template: true});
  },
  get: function (id) {
    // support `this.get()` to get the data context.
    if (id === undefined)
      id = ".";

    var result = this.lookup(id);
    return (typeof result === 'function' ? result() : result);
  },
  set: function (id, value) {
    var comp = findComponentWithProp(id, this);
    if (! comp || ! comp[id])
      throw new Error("Can't find field: " + id);
    if (typeof comp[id] !== 'function')
      throw new Error("Not a settable field: " + id);
    comp[id](value);
  }
});


}).call(this);






(function () {

                                                                                                        //
// XXX this file no longer makes sense in isolation.  take it apart as
// part file reorg on the 'ui' package
var globalHelpers = {};

UI.registerHelper = function (name, func) {
  globalHelpers[name] = func;
};

UI._globalHelper = function (name) {
  return globalHelpers[name];
};

Handlebars = {};
Handlebars.registerHelper = UI.registerHelper;

// Utility to HTML-escape a string.
UI._escape = Handlebars._escape = (function() {
  var escape_map = {
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "`": "&#x60;", /* IE allows backtick-delimited attributes?? */
    "&": "&amp;"
  };
  var escape_one = function(c) {
    return escape_map[c];
  };

  return function (x) {
    return x.replace(/[&<>"'`]/g, escape_one);
  };
})();

// Return these from {{...}} helpers to achieve the same as returning
// strings from {{{...}}} helpers
Handlebars.SafeString = function(string) {
  this.string = string;
};
Handlebars.SafeString.prototype.toString = function() {
  return this.string.toString();
};


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.ui = {
  UI: UI,
  Handlebars: Handlebars
};

})();



(function () {

/* Package-scope variables */
var _, exports;

(function () {

                                                                                                         //
// Define an object named exports. This will cause underscore.js to put `_` as a
// field on it, instead of in the global namespace.  See also post.js.
exports = {};


}).call(this);






(function () {

                                                                                                         //
//     Underscore.js 1.5.2
//     http://underscorejs.org
//     (c) 2009-2013 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
//     Underscore may be freely distributed under the MIT license.

(function() {

  // Baseline setup
  // --------------

  // Establish the root object, `window` in the browser, or `exports` on the server.
  var root = this;

  // Save the previous value of the `_` variable.
  var previousUnderscore = root._;

  // Establish the object that gets returned to break out of a loop iteration.
  var breaker = {};

  // Save bytes in the minified (but not gzipped) version:
  var ArrayProto = Array.prototype, ObjProto = Object.prototype, FuncProto = Function.prototype;

  // Create quick reference variables for speed access to core prototypes.
  var
    push             = ArrayProto.push,
    slice            = ArrayProto.slice,
    concat           = ArrayProto.concat,
    toString         = ObjProto.toString,
    hasOwnProperty   = ObjProto.hasOwnProperty;

  // All **ECMAScript 5** native function implementations that we hope to use
  // are declared here.
  var
    nativeForEach      = ArrayProto.forEach,
    nativeMap          = ArrayProto.map,
    nativeReduce       = ArrayProto.reduce,
    nativeReduceRight  = ArrayProto.reduceRight,
    nativeFilter       = ArrayProto.filter,
    nativeEvery        = ArrayProto.every,
    nativeSome         = ArrayProto.some,
    nativeIndexOf      = ArrayProto.indexOf,
    nativeLastIndexOf  = ArrayProto.lastIndexOf,
    nativeIsArray      = Array.isArray,
    nativeKeys         = Object.keys,
    nativeBind         = FuncProto.bind;

  // Create a safe reference to the Underscore object for use below.
  var _ = function(obj) {
    if (obj instanceof _) return obj;
    if (!(this instanceof _)) return new _(obj);
    this._wrapped = obj;
  };

  // Export the Underscore object for **Node.js**, with
  // backwards-compatibility for the old `require()` API. If we're in
  // the browser, add `_` as a global object via a string identifier,
  // for Closure Compiler "advanced" mode.
  if (typeof exports !== 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      exports = module.exports = _;
    }
    exports._ = _;
  } else {
    root._ = _;
  }

  // Current version.
  _.VERSION = '1.5.2';

  // Collection Functions
  // --------------------

  // METEOR CHANGE: Define _isArguments instead of depending on
  // _.isArguments which is defined using each. In looksLikeArray
  // (which each depends on), we then use _isArguments instead of
  // _.isArguments.
  var _isArguments = function (obj) {
    return toString.call(obj) === '[object Arguments]';
  };
  // Define a fallback version of the method in browsers (ahem, IE), where
  // there isn't any inspectable "Arguments" type.
  if (!_isArguments(arguments)) {
    _isArguments = function (obj) {
      return !!(obj && hasOwnProperty.call(obj, 'callee') && typeof obj.callee === 'function');
    };
  }

  // METEOR CHANGE: _.each({length: 5}) should be treated like an object, not an
  // array. This looksLikeArray function is introduced by Meteor, and replaces
  // all instances of `obj.length === +obj.length`.
  // https://github.com/meteor/meteor/issues/594
  // https://github.com/jashkenas/underscore/issues/770
  var looksLikeArray = function (obj) {
    return (obj.length === +obj.length
            // _.isArguments not yet necessarily defined here
            && (_isArguments(obj) || obj.constructor !== Object));
  };

  // The cornerstone, an `each` implementation, aka `forEach`.
  // Handles objects with the built-in `forEach`, arrays, and raw objects.
  // Delegates to **ECMAScript 5**'s native `forEach` if available.
  var each = _.each = _.forEach = function(obj, iterator, context) {
    if (obj == null) return;
    if (nativeForEach && obj.forEach === nativeForEach) {
      obj.forEach(iterator, context);
    } else if (looksLikeArray(obj)) {
      for (var i = 0, length = obj.length; i < length; i++) {
        if (iterator.call(context, obj[i], i, obj) === breaker) return;
      }
    } else {
      var keys = _.keys(obj);
      for (var i = 0, length = keys.length; i < length; i++) {
        if (iterator.call(context, obj[keys[i]], keys[i], obj) === breaker) return;
      }
    }
  };

  // Return the results of applying the iterator to each element.
  // Delegates to **ECMAScript 5**'s native `map` if available.
  _.map = _.collect = function(obj, iterator, context) {
    var results = [];
    if (obj == null) return results;
    if (nativeMap && obj.map === nativeMap) return obj.map(iterator, context);
    each(obj, function(value, index, list) {
      results.push(iterator.call(context, value, index, list));
    });
    return results;
  };

  var reduceError = 'Reduce of empty array with no initial value';

  // **Reduce** builds up a single result from a list of values, aka `inject`,
  // or `foldl`. Delegates to **ECMAScript 5**'s native `reduce` if available.
  _.reduce = _.foldl = _.inject = function(obj, iterator, memo, context) {
    var initial = arguments.length > 2;
    if (obj == null) obj = [];
    if (nativeReduce && obj.reduce === nativeReduce) {
      if (context) iterator = _.bind(iterator, context);
      return initial ? obj.reduce(iterator, memo) : obj.reduce(iterator);
    }
    each(obj, function(value, index, list) {
      if (!initial) {
        memo = value;
        initial = true;
      } else {
        memo = iterator.call(context, memo, value, index, list);
      }
    });
    if (!initial) throw new TypeError(reduceError);
    return memo;
  };

  // The right-associative version of reduce, also known as `foldr`.
  // Delegates to **ECMAScript 5**'s native `reduceRight` if available.
  _.reduceRight = _.foldr = function(obj, iterator, memo, context) {
    var initial = arguments.length > 2;
    if (obj == null) obj = [];
    if (nativeReduceRight && obj.reduceRight === nativeReduceRight) {
      if (context) iterator = _.bind(iterator, context);
      return initial ? obj.reduceRight(iterator, memo) : obj.reduceRight(iterator);
    }
    var length = obj.length;
    if (!looksLikeArray(obj)) {
      var keys = _.keys(obj);
      length = keys.length;
    }
    each(obj, function(value, index, list) {
      index = keys ? keys[--length] : --length;
      if (!initial) {
        memo = obj[index];
        initial = true;
      } else {
        memo = iterator.call(context, memo, obj[index], index, list);
      }
    });
    if (!initial) throw new TypeError(reduceError);
    return memo;
  };

  // Return the first value which passes a truth test. Aliased as `detect`.
  _.find = _.detect = function(obj, iterator, context) {
    var result;
    any(obj, function(value, index, list) {
      if (iterator.call(context, value, index, list)) {
        result = value;
        return true;
      }
    });
    return result;
  };

  // Return all the elements that pass a truth test.
  // Delegates to **ECMAScript 5**'s native `filter` if available.
  // Aliased as `select`.
  _.filter = _.select = function(obj, iterator, context) {
    var results = [];
    if (obj == null) return results;
    if (nativeFilter && obj.filter === nativeFilter) return obj.filter(iterator, context);
    each(obj, function(value, index, list) {
      if (iterator.call(context, value, index, list)) results.push(value);
    });
    return results;
  };

  // Return all the elements for which a truth test fails.
  _.reject = function(obj, iterator, context) {
    return _.filter(obj, function(value, index, list) {
      return !iterator.call(context, value, index, list);
    }, context);
  };

  // Determine whether all of the elements match a truth test.
  // Delegates to **ECMAScript 5**'s native `every` if available.
  // Aliased as `all`.
  _.every = _.all = function(obj, iterator, context) {
    iterator || (iterator = _.identity);
    var result = true;
    if (obj == null) return result;
    if (nativeEvery && obj.every === nativeEvery) return obj.every(iterator, context);
    each(obj, function(value, index, list) {
      if (!(result = result && iterator.call(context, value, index, list))) return breaker;
    });
    return !!result;
  };

  // Determine if at least one element in the object matches a truth test.
  // Delegates to **ECMAScript 5**'s native `some` if available.
  // Aliased as `any`.
  var any = _.some = _.any = function(obj, iterator, context) {
    iterator || (iterator = _.identity);
    var result = false;
    if (obj == null) return result;
    if (nativeSome && obj.some === nativeSome) return obj.some(iterator, context);
    each(obj, function(value, index, list) {
      if (result || (result = iterator.call(context, value, index, list))) return breaker;
    });
    return !!result;
  };

  // Determine if the array or object contains a given value (using `===`).
  // Aliased as `include`.
  _.contains = _.include = function(obj, target) {
    if (obj == null) return false;
    if (nativeIndexOf && obj.indexOf === nativeIndexOf) return obj.indexOf(target) != -1;
    return any(obj, function(value) {
      return value === target;
    });
  };

  // Invoke a method (with arguments) on every item in a collection.
  _.invoke = function(obj, method) {
    var args = slice.call(arguments, 2);
    var isFunc = _.isFunction(method);
    return _.map(obj, function(value) {
      return (isFunc ? method : value[method]).apply(value, args);
    });
  };

  // Convenience version of a common use case of `map`: fetching a property.
  _.pluck = function(obj, key) {
    return _.map(obj, function(value){ return value[key]; });
  };

  // Convenience version of a common use case of `filter`: selecting only objects
  // containing specific `key:value` pairs.
  _.where = function(obj, attrs, first) {
    if (_.isEmpty(attrs)) return first ? void 0 : [];
    return _[first ? 'find' : 'filter'](obj, function(value) {
      for (var key in attrs) {
        if (attrs[key] !== value[key]) return false;
      }
      return true;
    });
  };

  // Convenience version of a common use case of `find`: getting the first object
  // containing specific `key:value` pairs.
  _.findWhere = function(obj, attrs) {
    return _.where(obj, attrs, true);
  };

  // Return the maximum element or (element-based computation).
  // Can't optimize arrays of integers longer than 65,535 elements.
  // See [WebKit Bug 80797](https://bugs.webkit.org/show_bug.cgi?id=80797)
  _.max = function(obj, iterator, context) {
    if (!iterator && _.isArray(obj) && obj[0] === +obj[0] && obj.length < 65535) {
      return Math.max.apply(Math, obj);
    }
    if (!iterator && _.isEmpty(obj)) return -Infinity;
    var result = {computed : -Infinity, value: -Infinity};
    each(obj, function(value, index, list) {
      var computed = iterator ? iterator.call(context, value, index, list) : value;
      computed > result.computed && (result = {value : value, computed : computed});
    });
    return result.value;
  };

  // Return the minimum element (or element-based computation).
  _.min = function(obj, iterator, context) {
    if (!iterator && _.isArray(obj) && obj[0] === +obj[0] && obj.length < 65535) {
      return Math.min.apply(Math, obj);
    }
    if (!iterator && _.isEmpty(obj)) return Infinity;
    var result = {computed : Infinity, value: Infinity};
    each(obj, function(value, index, list) {
      var computed = iterator ? iterator.call(context, value, index, list) : value;
      computed < result.computed && (result = {value : value, computed : computed});
    });
    return result.value;
  };

  // Shuffle an array, using the modern version of the
  // [Fisher-Yates shuffle](http://en.wikipedia.org/wiki/Fisher–Yates_shuffle).
  _.shuffle = function(obj) {
    var rand;
    var index = 0;
    var shuffled = [];
    each(obj, function(value) {
      rand = _.random(index++);
      shuffled[index - 1] = shuffled[rand];
      shuffled[rand] = value;
    });
    return shuffled;
  };

  // Sample **n** random values from an array.
  // If **n** is not specified, returns a single random element from the array.
  // The internal `guard` argument allows it to work with `map`.
  _.sample = function(obj, n, guard) {
    if (arguments.length < 2 || guard) {
      return obj[_.random(obj.length - 1)];
    }
    return _.shuffle(obj).slice(0, Math.max(0, n));
  };

  // An internal function to generate lookup iterators.
  var lookupIterator = function(value) {
    return _.isFunction(value) ? value : function(obj){ return obj[value]; };
  };

  // Sort the object's values by a criterion produced by an iterator.
  _.sortBy = function(obj, value, context) {
    var iterator = lookupIterator(value);
    return _.pluck(_.map(obj, function(value, index, list) {
      return {
        value: value,
        index: index,
        criteria: iterator.call(context, value, index, list)
      };
    }).sort(function(left, right) {
      var a = left.criteria;
      var b = right.criteria;
      if (a !== b) {
        if (a > b || a === void 0) return 1;
        if (a < b || b === void 0) return -1;
      }
      return left.index - right.index;
    }), 'value');
  };

  // An internal function used for aggregate "group by" operations.
  var group = function(behavior) {
    return function(obj, value, context) {
      var result = {};
      var iterator = value == null ? _.identity : lookupIterator(value);
      each(obj, function(value, index) {
        var key = iterator.call(context, value, index, obj);
        behavior(result, key, value);
      });
      return result;
    };
  };

  // Groups the object's values by a criterion. Pass either a string attribute
  // to group by, or a function that returns the criterion.
  _.groupBy = group(function(result, key, value) {
    (_.has(result, key) ? result[key] : (result[key] = [])).push(value);
  });

  // Indexes the object's values by a criterion, similar to `groupBy`, but for
  // when you know that your index values will be unique.
  _.indexBy = group(function(result, key, value) {
    result[key] = value;
  });

  // Counts instances of an object that group by a certain criterion. Pass
  // either a string attribute to count by, or a function that returns the
  // criterion.
  _.countBy = group(function(result, key) {
    _.has(result, key) ? result[key]++ : result[key] = 1;
  });

  // Use a comparator function to figure out the smallest index at which
  // an object should be inserted so as to maintain order. Uses binary search.
  _.sortedIndex = function(array, obj, iterator, context) {
    iterator = iterator == null ? _.identity : lookupIterator(iterator);
    var value = iterator.call(context, obj);
    var low = 0, high = array.length;
    while (low < high) {
      var mid = (low + high) >>> 1;
      iterator.call(context, array[mid]) < value ? low = mid + 1 : high = mid;
    }
    return low;
  };

  // Safely create a real, live array from anything iterable.
  _.toArray = function(obj) {
    if (!obj) return [];
    if (_.isArray(obj)) return slice.call(obj);
    if (looksLikeArray(obj)) return _.map(obj, _.identity);
    return _.values(obj);
  };

  // Return the number of elements in an object.
  _.size = function(obj) {
    if (obj == null) return 0;
    return (looksLikeArray(obj)) ? obj.length : _.keys(obj).length;
  };

  // Array Functions
  // ---------------

  // Get the first element of an array. Passing **n** will return the first N
  // values in the array. Aliased as `head` and `take`. The **guard** check
  // allows it to work with `_.map`.
  _.first = _.head = _.take = function(array, n, guard) {
    if (array == null) return void 0;
    return (n == null) || guard ? array[0] : slice.call(array, 0, n);
  };

  // Returns everything but the last entry of the array. Especially useful on
  // the arguments object. Passing **n** will return all the values in
  // the array, excluding the last N. The **guard** check allows it to work with
  // `_.map`.
  _.initial = function(array, n, guard) {
    return slice.call(array, 0, array.length - ((n == null) || guard ? 1 : n));
  };

  // Get the last element of an array. Passing **n** will return the last N
  // values in the array. The **guard** check allows it to work with `_.map`.
  _.last = function(array, n, guard) {
    if (array == null) return void 0;
    if ((n == null) || guard) {
      return array[array.length - 1];
    } else {
      return slice.call(array, Math.max(array.length - n, 0));
    }
  };

  // Returns everything but the first entry of the array. Aliased as `tail` and `drop`.
  // Especially useful on the arguments object. Passing an **n** will return
  // the rest N values in the array. The **guard**
  // check allows it to work with `_.map`.
  _.rest = _.tail = _.drop = function(array, n, guard) {
    return slice.call(array, (n == null) || guard ? 1 : n);
  };

  // Trim out all falsy values from an array.
  _.compact = function(array) {
    return _.filter(array, _.identity);
  };

  // Internal implementation of a recursive `flatten` function.
  var flatten = function(input, shallow, output) {
    if (shallow && _.every(input, _.isArray)) {
      return concat.apply(output, input);
    }
    each(input, function(value) {
      if (_.isArray(value) || _.isArguments(value)) {
        shallow ? push.apply(output, value) : flatten(value, shallow, output);
      } else {
        output.push(value);
      }
    });
    return output;
  };

  // Flatten out an array, either recursively (by default), or just one level.
  _.flatten = function(array, shallow) {
    return flatten(array, shallow, []);
  };

  // Return a version of the array that does not contain the specified value(s).
  _.without = function(array) {
    return _.difference(array, slice.call(arguments, 1));
  };

  // Produce a duplicate-free version of the array. If the array has already
  // been sorted, you have the option of using a faster algorithm.
  // Aliased as `unique`.
  _.uniq = _.unique = function(array, isSorted, iterator, context) {
    if (_.isFunction(isSorted)) {
      context = iterator;
      iterator = isSorted;
      isSorted = false;
    }
    var initial = iterator ? _.map(array, iterator, context) : array;
    var results = [];
    var seen = [];
    each(initial, function(value, index) {
      if (isSorted ? (!index || seen[seen.length - 1] !== value) : !_.contains(seen, value)) {
        seen.push(value);
        results.push(array[index]);
      }
    });
    return results;
  };

  // Produce an array that contains the union: each distinct element from all of
  // the passed-in arrays.
  _.union = function() {
    return _.uniq(_.flatten(arguments, true));
  };

  // Produce an array that contains every item shared between all the
  // passed-in arrays.
  _.intersection = function(array) {
    var rest = slice.call(arguments, 1);
    return _.filter(_.uniq(array), function(item) {
      return _.every(rest, function(other) {
        return _.indexOf(other, item) >= 0;
      });
    });
  };

  // Take the difference between one array and a number of other arrays.
  // Only the elements present in just the first array will remain.
  _.difference = function(array) {
    var rest = concat.apply(ArrayProto, slice.call(arguments, 1));
    return _.filter(array, function(value){ return !_.contains(rest, value); });
  };

  // Zip together multiple lists into a single array -- elements that share
  // an index go together.
  _.zip = function() {
    var length = _.max(_.pluck(arguments, "length").concat(0));
    var results = new Array(length);
    for (var i = 0; i < length; i++) {
      results[i] = _.pluck(arguments, '' + i);
    }
    return results;
  };

  // Converts lists into objects. Pass either a single array of `[key, value]`
  // pairs, or two parallel arrays of the same length -- one of keys, and one of
  // the corresponding values.
  _.object = function(list, values) {
    if (list == null) return {};
    var result = {};
    for (var i = 0, length = list.length; i < length; i++) {
      if (values) {
        result[list[i]] = values[i];
      } else {
        result[list[i][0]] = list[i][1];
      }
    }
    return result;
  };

  // If the browser doesn't supply us with indexOf (I'm looking at you, **MSIE**),
  // we need this function. Return the position of the first occurrence of an
  // item in an array, or -1 if the item is not included in the array.
  // Delegates to **ECMAScript 5**'s native `indexOf` if available.
  // If the array is large and already in sort order, pass `true`
  // for **isSorted** to use binary search.
  _.indexOf = function(array, item, isSorted) {
    if (array == null) return -1;
    var i = 0, length = array.length;
    if (isSorted) {
      if (typeof isSorted == 'number') {
        i = (isSorted < 0 ? Math.max(0, length + isSorted) : isSorted);
      } else {
        i = _.sortedIndex(array, item);
        return array[i] === item ? i : -1;
      }
    }
    if (nativeIndexOf && array.indexOf === nativeIndexOf) return array.indexOf(item, isSorted);
    for (; i < length; i++) if (array[i] === item) return i;
    return -1;
  };

  // Delegates to **ECMAScript 5**'s native `lastIndexOf` if available.
  _.lastIndexOf = function(array, item, from) {
    if (array == null) return -1;
    var hasIndex = from != null;
    if (nativeLastIndexOf && array.lastIndexOf === nativeLastIndexOf) {
      return hasIndex ? array.lastIndexOf(item, from) : array.lastIndexOf(item);
    }
    var i = (hasIndex ? from : array.length);
    while (i--) if (array[i] === item) return i;
    return -1;
  };

  // Generate an integer Array containing an arithmetic progression. A port of
  // the native Python `range()` function. See
  // [the Python documentation](http://docs.python.org/library/functions.html#range).
  _.range = function(start, stop, step) {
    if (arguments.length <= 1) {
      stop = start || 0;
      start = 0;
    }
    step = arguments[2] || 1;

    var length = Math.max(Math.ceil((stop - start) / step), 0);
    var idx = 0;
    var range = new Array(length);

    while(idx < length) {
      range[idx++] = start;
      start += step;
    }

    return range;
  };

  // Function (ahem) Functions
  // ------------------

  // Reusable constructor function for prototype setting.
  var ctor = function(){};

  // Create a function bound to a given object (assigning `this`, and arguments,
  // optionally). Delegates to **ECMAScript 5**'s native `Function.bind` if
  // available.
  _.bind = function(func, context) {
    var args, bound;
    if (nativeBind && func.bind === nativeBind) return nativeBind.apply(func, slice.call(arguments, 1));
    if (!_.isFunction(func)) throw new TypeError;
    args = slice.call(arguments, 2);
    return bound = function() {
      if (!(this instanceof bound)) return func.apply(context, args.concat(slice.call(arguments)));
      ctor.prototype = func.prototype;
      var self = new ctor;
      ctor.prototype = null;
      var result = func.apply(self, args.concat(slice.call(arguments)));
      if (Object(result) === result) return result;
      return self;
    };
  };

  // Partially apply a function by creating a version that has had some of its
  // arguments pre-filled, without changing its dynamic `this` context.
  _.partial = function(func) {
    var args = slice.call(arguments, 1);
    return function() {
      return func.apply(this, args.concat(slice.call(arguments)));
    };
  };

  // Bind all of an object's methods to that object. Useful for ensuring that
  // all callbacks defined on an object belong to it.
  _.bindAll = function(obj) {
    var funcs = slice.call(arguments, 1);
    if (funcs.length === 0) throw new Error("bindAll must be passed function names");
    each(funcs, function(f) { obj[f] = _.bind(obj[f], obj); });
    return obj;
  };

  // Memoize an expensive function by storing its results.
  _.memoize = function(func, hasher) {
    var memo = {};
    hasher || (hasher = _.identity);
    return function() {
      var key = hasher.apply(this, arguments);
      return _.has(memo, key) ? memo[key] : (memo[key] = func.apply(this, arguments));
    };
  };

  // Delays a function for the given number of milliseconds, and then calls
  // it with the arguments supplied.
  _.delay = function(func, wait) {
    var args = slice.call(arguments, 2);
    return setTimeout(function(){ return func.apply(null, args); }, wait);
  };

  // Defers a function, scheduling it to run after the current call stack has
  // cleared.
  _.defer = function(func) {
    return _.delay.apply(_, [func, 1].concat(slice.call(arguments, 1)));
  };

  // Returns a function, that, when invoked, will only be triggered at most once
  // during a given window of time. Normally, the throttled function will run
  // as much as it can, without ever going more than once per `wait` duration;
  // but if you'd like to disable the execution on the leading edge, pass
  // `{leading: false}`. To disable execution on the trailing edge, ditto.
  _.throttle = function(func, wait, options) {
    var context, args, result;
    var timeout = null;
    var previous = 0;
    options || (options = {});
    var later = function() {
      previous = options.leading === false ? 0 : new Date;
      timeout = null;
      result = func.apply(context, args);
    };
    return function() {
      var now = new Date;
      if (!previous && options.leading === false) previous = now;
      var remaining = wait - (now - previous);
      context = this;
      args = arguments;
      if (remaining <= 0) {
        clearTimeout(timeout);
        timeout = null;
        previous = now;
        result = func.apply(context, args);
      } else if (!timeout && options.trailing !== false) {
        timeout = setTimeout(later, remaining);
      }
      return result;
    };
  };

  // Returns a function, that, as long as it continues to be invoked, will not
  // be triggered. The function will be called after it stops being called for
  // N milliseconds. If `immediate` is passed, trigger the function on the
  // leading edge, instead of the trailing.
  _.debounce = function(func, wait, immediate) {
    var timeout, args, context, timestamp, result;
    return function() {
      context = this;
      args = arguments;
      timestamp = new Date();
      var later = function() {
        var last = (new Date()) - timestamp;
        if (last < wait) {
          timeout = setTimeout(later, wait - last);
        } else {
          timeout = null;
          if (!immediate) result = func.apply(context, args);
        }
      };
      var callNow = immediate && !timeout;
      if (!timeout) {
        timeout = setTimeout(later, wait);
      }
      if (callNow) result = func.apply(context, args);
      return result;
    };
  };

  // Returns a function that will be executed at most one time, no matter how
  // often you call it. Useful for lazy initialization.
  _.once = function(func) {
    var ran = false, memo;
    return function() {
      if (ran) return memo;
      ran = true;
      memo = func.apply(this, arguments);
      func = null;
      return memo;
    };
  };

  // Returns the first function passed as an argument to the second,
  // allowing you to adjust arguments, run code before and after, and
  // conditionally execute the original function.
  _.wrap = function(func, wrapper) {
    return function() {
      var args = [func];
      push.apply(args, arguments);
      return wrapper.apply(this, args);
    };
  };

  // Returns a function that is the composition of a list of functions, each
  // consuming the return value of the function that follows.
  _.compose = function() {
    var funcs = arguments;
    return function() {
      var args = arguments;
      for (var i = funcs.length - 1; i >= 0; i--) {
        args = [funcs[i].apply(this, args)];
      }
      return args[0];
    };
  };

  // Returns a function that will only be executed after being called N times.
  _.after = function(times, func) {
    return function() {
      if (--times < 1) {
        return func.apply(this, arguments);
      }
    };
  };

  // Object Functions
  // ----------------

  // Retrieve the names of an object's properties.
  // Delegates to **ECMAScript 5**'s native `Object.keys`
  _.keys = nativeKeys || function(obj) {
    if (obj !== Object(obj)) throw new TypeError('Invalid object');
    var keys = [];
    for (var key in obj) if (_.has(obj, key)) keys.push(key);
    return keys;
  };

  // Retrieve the values of an object's properties.
  _.values = function(obj) {
    var keys = _.keys(obj);
    var length = keys.length;
    var values = new Array(length);
    for (var i = 0; i < length; i++) {
      values[i] = obj[keys[i]];
    }
    return values;
  };

  // Convert an object into a list of `[key, value]` pairs.
  _.pairs = function(obj) {
    var keys = _.keys(obj);
    var length = keys.length;
    var pairs = new Array(length);
    for (var i = 0; i < length; i++) {
      pairs[i] = [keys[i], obj[keys[i]]];
    }
    return pairs;
  };

  // Invert the keys and values of an object. The values must be serializable.
  _.invert = function(obj) {
    var result = {};
    var keys = _.keys(obj);
    for (var i = 0, length = keys.length; i < length; i++) {
      result[obj[keys[i]]] = keys[i];
    }
    return result;
  };

  // Return a sorted list of the function names available on the object.
  // Aliased as `methods`
  _.functions = _.methods = function(obj) {
    var names = [];
    for (var key in obj) {
      if (_.isFunction(obj[key])) names.push(key);
    }
    return names.sort();
  };

  // Extend a given object with all the properties in passed-in object(s).
  _.extend = function(obj) {
    each(slice.call(arguments, 1), function(source) {
      if (source) {
        for (var prop in source) {
          obj[prop] = source[prop];
        }
      }
    });
    return obj;
  };

  // Return a copy of the object only containing the whitelisted properties.
  _.pick = function(obj) {
    var copy = {};
    var keys = concat.apply(ArrayProto, slice.call(arguments, 1));
    each(keys, function(key) {
      if (key in obj) copy[key] = obj[key];
    });
    return copy;
  };

   // Return a copy of the object without the blacklisted properties.
  _.omit = function(obj) {
    var copy = {};
    var keys = concat.apply(ArrayProto, slice.call(arguments, 1));
    for (var key in obj) {
      if (!_.contains(keys, key)) copy[key] = obj[key];
    }
    return copy;
  };

  // Fill in a given object with default properties.
  _.defaults = function(obj) {
    each(slice.call(arguments, 1), function(source) {
      if (source) {
        for (var prop in source) {
          if (obj[prop] === void 0) obj[prop] = source[prop];
        }
      }
    });
    return obj;
  };

  // Create a (shallow-cloned) duplicate of an object.
  _.clone = function(obj) {
    if (!_.isObject(obj)) return obj;
    return _.isArray(obj) ? obj.slice() : _.extend({}, obj);
  };

  // Invokes interceptor with the obj, and then returns obj.
  // The primary purpose of this method is to "tap into" a method chain, in
  // order to perform operations on intermediate results within the chain.
  _.tap = function(obj, interceptor) {
    interceptor(obj);
    return obj;
  };

  // Internal recursive comparison function for `isEqual`.
  var eq = function(a, b, aStack, bStack) {
    // Identical objects are equal. `0 === -0`, but they aren't identical.
    // See the [Harmony `egal` proposal](http://wiki.ecmascript.org/doku.php?id=harmony:egal).
    if (a === b) return a !== 0 || 1 / a == 1 / b;
    // A strict comparison is necessary because `null == undefined`.
    if (a == null || b == null) return a === b;
    // Unwrap any wrapped objects.
    if (a instanceof _) a = a._wrapped;
    if (b instanceof _) b = b._wrapped;
    // Compare `[[Class]]` names.
    var className = toString.call(a);
    if (className != toString.call(b)) return false;
    switch (className) {
      // Strings, numbers, dates, and booleans are compared by value.
      case '[object String]':
        // Primitives and their corresponding object wrappers are equivalent; thus, `"5"` is
        // equivalent to `new String("5")`.
        return a == String(b);
      case '[object Number]':
        // `NaN`s are equivalent, but non-reflexive. An `egal` comparison is performed for
        // other numeric values.
        return a != +a ? b != +b : (a == 0 ? 1 / a == 1 / b : a == +b);
      case '[object Date]':
      case '[object Boolean]':
        // Coerce dates and booleans to numeric primitive values. Dates are compared by their
        // millisecond representations. Note that invalid dates with millisecond representations
        // of `NaN` are not equivalent.
        return +a == +b;
      // RegExps are compared by their source patterns and flags.
      case '[object RegExp]':
        return a.source == b.source &&
               a.global == b.global &&
               a.multiline == b.multiline &&
               a.ignoreCase == b.ignoreCase;
    }
    if (typeof a != 'object' || typeof b != 'object') return false;
    // Assume equality for cyclic structures. The algorithm for detecting cyclic
    // structures is adapted from ES 5.1 section 15.12.3, abstract operation `JO`.
    var length = aStack.length;
    while (length--) {
      // Linear search. Performance is inversely proportional to the number of
      // unique nested structures.
      if (aStack[length] == a) return bStack[length] == b;
    }
    // Objects with different constructors are not equivalent, but `Object`s
    // from different frames are.
    var aCtor = a.constructor, bCtor = b.constructor;
    if (aCtor !== bCtor && !(_.isFunction(aCtor) && (aCtor instanceof aCtor) &&
                             _.isFunction(bCtor) && (bCtor instanceof bCtor))) {
      return false;
    }
    // Add the first object to the stack of traversed objects.
    aStack.push(a);
    bStack.push(b);
    var size = 0, result = true;
    // Recursively compare objects and arrays.
    if (className == '[object Array]') {
      // Compare array lengths to determine if a deep comparison is necessary.
      size = a.length;
      result = size == b.length;
      if (result) {
        // Deep compare the contents, ignoring non-numeric properties.
        while (size--) {
          if (!(result = eq(a[size], b[size], aStack, bStack))) break;
        }
      }
    } else {
      // Deep compare objects.
      for (var key in a) {
        if (_.has(a, key)) {
          // Count the expected number of properties.
          size++;
          // Deep compare each member.
          if (!(result = _.has(b, key) && eq(a[key], b[key], aStack, bStack))) break;
        }
      }
      // Ensure that both objects contain the same number of properties.
      if (result) {
        for (key in b) {
          if (_.has(b, key) && !(size--)) break;
        }
        result = !size;
      }
    }
    // Remove the first object from the stack of traversed objects.
    aStack.pop();
    bStack.pop();
    return result;
  };

  // Perform a deep comparison to check if two objects are equal.
  _.isEqual = function(a, b) {
    return eq(a, b, [], []);
  };

  // Is a given array, string, or object empty?
  // An "empty" object has no enumerable own-properties.
  _.isEmpty = function(obj) {
    if (obj == null) return true;
    if (_.isArray(obj) || _.isString(obj)) return obj.length === 0;
    for (var key in obj) if (_.has(obj, key)) return false;
    return true;
  };

  // Is a given value a DOM element?
  _.isElement = function(obj) {
    return !!(obj && obj.nodeType === 1);
  };

  // Is a given value an array?
  // Delegates to ECMA5's native Array.isArray
  _.isArray = nativeIsArray || function(obj) {
    return toString.call(obj) == '[object Array]';
  };

  // Is a given variable an object?
  _.isObject = function(obj) {
    return obj === Object(obj);
  };

  // Add some isType methods: isArguments, isFunction, isString, isNumber, isDate, isRegExp.
  each(['Arguments', 'Function', 'String', 'Number', 'Date', 'RegExp'], function(name) {
    _['is' + name] = function(obj) {
      return toString.call(obj) == '[object ' + name + ']';
    };
  });

  // Define a fallback version of the method in browsers (ahem, IE), where
  // there isn't any inspectable "Arguments" type.
  if (!_.isArguments(arguments)) {
    _.isArguments = function(obj) {
      return !!(obj && _.has(obj, 'callee'));
    };
  }

  // Optimize `isFunction` if appropriate.
  if (typeof (/./) !== 'function') {
    _.isFunction = function(obj) {
      return typeof obj === 'function';
    };
  }

  // Is a given object a finite number?
  _.isFinite = function(obj) {
    return isFinite(obj) && !isNaN(parseFloat(obj));
  };

  // Is the given value `NaN`? (NaN is the only number which does not equal itself).
  _.isNaN = function(obj) {
    return _.isNumber(obj) && obj != +obj;
  };

  // Is a given value a boolean?
  _.isBoolean = function(obj) {
    return obj === true || obj === false || toString.call(obj) == '[object Boolean]';
  };

  // Is a given value equal to null?
  _.isNull = function(obj) {
    return obj === null;
  };

  // Is a given variable undefined?
  _.isUndefined = function(obj) {
    return obj === void 0;
  };

  // Shortcut function for checking if an object has a given property directly
  // on itself (in other words, not on a prototype).
  _.has = function(obj, key) {
    return hasOwnProperty.call(obj, key);
  };

  // Utility Functions
  // -----------------

  // Run Underscore.js in *noConflict* mode, returning the `_` variable to its
  // previous owner. Returns a reference to the Underscore object.
  _.noConflict = function() {
    root._ = previousUnderscore;
    return this;
  };

  // Keep the identity function around for default iterators.
  _.identity = function(value) {
    return value;
  };

  // Run a function **n** times.
  _.times = function(n, iterator, context) {
    var accum = Array(Math.max(0, n));
    for (var i = 0; i < n; i++) accum[i] = iterator.call(context, i);
    return accum;
  };

  // Return a random integer between min and max (inclusive).
  _.random = function(min, max) {
    if (max == null) {
      max = min;
      min = 0;
    }
    return min + Math.floor(Math.random() * (max - min + 1));
  };

  // List of HTML entities for escaping.
  var entityMap = {
    escape: {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;'
    }
  };
  entityMap.unescape = _.invert(entityMap.escape);

  // Regexes containing the keys and values listed immediately above.
  var entityRegexes = {
    escape:   new RegExp('[' + _.keys(entityMap.escape).join('') + ']', 'g'),
    unescape: new RegExp('(' + _.keys(entityMap.unescape).join('|') + ')', 'g')
  };

  // Functions for escaping and unescaping strings to/from HTML interpolation.
  _.each(['escape', 'unescape'], function(method) {
    _[method] = function(string) {
      if (string == null) return '';
      return ('' + string).replace(entityRegexes[method], function(match) {
        return entityMap[method][match];
      });
    };
  });

  // If the value of the named `property` is a function then invoke it with the
  // `object` as context; otherwise, return it.
  _.result = function(object, property) {
    if (object == null) return void 0;
    var value = object[property];
    return _.isFunction(value) ? value.call(object) : value;
  };

  // Add your own custom functions to the Underscore object.
  _.mixin = function(obj) {
    each(_.functions(obj), function(name) {
      var func = _[name] = obj[name];
      _.prototype[name] = function() {
        var args = [this._wrapped];
        push.apply(args, arguments);
        return result.call(this, func.apply(_, args));
      };
    });
  };

  // Generate a unique integer id (unique within the entire client session).
  // Useful for temporary DOM ids.
  var idCounter = 0;
  _.uniqueId = function(prefix) {
    var id = ++idCounter + '';
    return prefix ? prefix + id : id;
  };

  // By default, Underscore uses ERB-style template delimiters, change the
  // following template settings to use alternative delimiters.
  _.templateSettings = {
    evaluate    : /<%([\s\S]+?)%>/g,
    interpolate : /<%=([\s\S]+?)%>/g,
    escape      : /<%-([\s\S]+?)%>/g
  };

  // When customizing `templateSettings`, if you don't want to define an
  // interpolation, evaluation or escaping regex, we need one that is
  // guaranteed not to match.
  var noMatch = /(.)^/;

  // Certain characters need to be escaped so that they can be put into a
  // string literal.
  var escapes = {
    "'":      "'",
    '\\':     '\\',
    '\r':     'r',
    '\n':     'n',
    '\t':     't',
    '\u2028': 'u2028',
    '\u2029': 'u2029'
  };

  var escaper = /\\|'|\r|\n|\t|\u2028|\u2029/g;

  // JavaScript micro-templating, similar to John Resig's implementation.
  // Underscore templating handles arbitrary delimiters, preserves whitespace,
  // and correctly escapes quotes within interpolated code.
  _.template = function(text, data, settings) {
    var render;
    settings = _.defaults({}, settings, _.templateSettings);

    // Combine delimiters into one regular expression via alternation.
    var matcher = new RegExp([
      (settings.escape || noMatch).source,
      (settings.interpolate || noMatch).source,
      (settings.evaluate || noMatch).source
    ].join('|') + '|$', 'g');

    // Compile the template source, escaping string literals appropriately.
    var index = 0;
    var source = "__p+='";
    text.replace(matcher, function(match, escape, interpolate, evaluate, offset) {
      source += text.slice(index, offset)
        .replace(escaper, function(match) { return '\\' + escapes[match]; });

      if (escape) {
        source += "'+\n((__t=(" + escape + "))==null?'':_.escape(__t))+\n'";
      }
      if (interpolate) {
        source += "'+\n((__t=(" + interpolate + "))==null?'':__t)+\n'";
      }
      if (evaluate) {
        source += "';\n" + evaluate + "\n__p+='";
      }
      index = offset + match.length;
      return match;
    });
    source += "';\n";

    // If a variable is not specified, place data values in local scope.
    if (!settings.variable) source = 'with(obj||{}){\n' + source + '}\n';

    source = "var __t,__p='',__j=Array.prototype.join," +
      "print=function(){__p+=__j.call(arguments,'');};\n" +
      source + "return __p;\n";

    try {
      render = new Function(settings.variable || 'obj', '_', source);
    } catch (e) {
      e.source = source;
      throw e;
    }

    if (data) return render(data, _);
    var template = function(data) {
      return render.call(this, data, _);
    };

    // Provide the compiled function source as a convenience for precompilation.
    template.source = 'function(' + (settings.variable || 'obj') + '){\n' + source + '}';

    return template;
  };

  // Add a "chain" function, which will delegate to the wrapper.
  _.chain = function(obj) {
    return _(obj).chain();
  };

  // OOP
  // ---------------
  // If Underscore is called as a function, it returns a wrapped object that
  // can be used OO-style. This wrapper holds altered versions of all the
  // underscore functions. Wrapped objects may be chained.

  // Helper function to continue chaining intermediate results.
  var result = function(obj) {
    return this._chain ? _(obj).chain() : obj;
  };

  // Add all of the Underscore functions to the wrapper object.
  _.mixin(_);

  // Add all mutator Array functions to the wrapper.
  each(['pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'], function(name) {
    var method = ArrayProto[name];
    _.prototype[name] = function() {
      var obj = this._wrapped;
      method.apply(obj, arguments);
      if ((name == 'shift' || name == 'splice') && obj.length === 0) delete obj[0];
      return result.call(this, obj);
    };
  });

  // Add all accessor Array functions to the wrapper.
  each(['concat', 'join', 'slice'], function(name) {
    var method = ArrayProto[name];
    _.prototype[name] = function() {
      return result.call(this, method.apply(this._wrapped, arguments));
    };
  });

  _.extend(_.prototype, {

    // Start chaining a wrapped Underscore object.
    chain: function() {
      this._chain = true;
      return this;
    },

    // Extracts the result from a wrapped and chained object.
    value: function() {
      return this._wrapped;
    }

  });

}).call(this);


}).call(this);






(function () {

                                                                                                         //
// This exports object was created in pre.js.  Now copy the `_` object from it
// into the package-scope variable `_`, which will get exported.
_ = exports._;


}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.underscore = {
  _: _
};

})();

$("script[type='text/spacebars']").each(function (index, script) {
  var name = script.getAttribute('name');
  var renderFuncCode = Spacebars.compile(script.innerHTML);
  eval("Template.__define__(" + JSON.stringify(name) +
       ", " + renderFuncCode + ");");
});

$(document).ready(function () {
  if (Template.main) {
    UI.insert(UI.render(Template.main), document.body);
  }
});

Deps = Package.deps.Deps;
Blaze = {};
Blaze.Var = function (initVal) {
  if (! (this instanceof Blaze.Var))
    return new Blaze.Var(initVal);
  this._dep = new Deps.Dependency;
  this._value = initVal;
};

Blaze.Var.prototype.get = function () {
  this._dep.depend();
  return this._value;
};

Blaze.Var.prototype.set = function (val) {
  if (this._value === val)
    return val;
  this._dep.changed();
  this._value = val;
};
