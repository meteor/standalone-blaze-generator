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
  return (this._value = val);
};
