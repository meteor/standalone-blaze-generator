$("script[type='text/spacebars']").each(function (index, script) {
  var name = script.getAttribute('name');
  var renderFuncCode = SpacebarsCompiler.compile(script.innerHTML, {isTemplate: true});
  eval("Template.__define__(" + JSON.stringify(name) +
       ", " + renderFuncCode + ");");
});

$(document).ready(function () {
  if (Template.main) {
    Blaze.render(Template.main, document.body);
  }
});

Blaze.Var = ReactiveVar;
