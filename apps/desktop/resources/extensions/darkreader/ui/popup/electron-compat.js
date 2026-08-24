(function () {
  chrome.tabs.create ||= function (details, callback) {
    const opened = details?.url ? window.open(details.url, "_blank") : null;
    callback?.(opened ? {} : null);
  };
  if (!chrome.windows) {
    chrome.windows = {
      getAll(_options, callback) {
        callback([]);
      },
      update(_windowId, _options, callback) {
        callback?.(null);
      },
      create(options, callback) {
        const opened = options?.url ? window.open(options.url, "_blank") : null;
        callback?.(opened ? {} : null);
      },
    };
  }
})();
