(function () {
  try {
    var meta = document.querySelector('meta[name="vellum:api-base-url"]');
    var value = meta && meta.getAttribute("content");
    if (value && value.trim() && !window.__VELLUM_API_BASE_URL__) {
      window.__VELLUM_API_BASE_URL__ = value.trim();
    }
  } catch (_) {
    /* bootstrap must never prevent the app from loading */
  }
})();
