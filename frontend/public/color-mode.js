(function () {
  try {
    var mode = localStorage.getItem("theme");
    if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
  } catch (e) {}
})();
