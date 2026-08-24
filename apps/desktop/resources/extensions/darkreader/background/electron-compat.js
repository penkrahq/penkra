// Electron intentionally implements only a subset of Chrome's extension APIs.
// Keep Dark Reader's own background and popup intact while adapting unsupported
// browser-shell services to the Penkra-hosted session.
(function () {
  const event = () => ({ addListener() {}, removeListener() {} });
  const addMessageListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
  chrome.runtime.onMessage.addListener = function (listener) {
    addMessageListener(function (message, sender, sendResponse) {
      if (
        !sender.url &&
        sender.id === chrome.runtime.id &&
        String(message?.type).startsWith("ui-bg-")
      ) {
        sender.url = chrome.runtime.getURL("/ui/popup/index.html");
      }
      return listener(message, sender, sendResponse);
    });
  };

  if (!chrome.browserAction) {
    chrome.browserAction = {};
  }
  chrome.browserAction.setIcon ||= function () {};
  chrome.browserAction.setBadgeText ||= function () {};
  chrome.browserAction.setBadgeBackgroundColor ||= function () {};

  if (!chrome.alarms) {
    chrome.alarms = {
      onAlarm: event(),
      create() {},
      clear(_name, callback) {
        callback?.(true);
      },
    };
  }

  if (!chrome.permissions) {
    chrome.permissions = {
      onAdded: event(),
      onRemoved: event(),
      contains(_permissions, callback) {
        callback(false);
      },
      request(_permissions, callback) {
        callback(false);
      },
      remove(_permissions, callback) {
        callback(false);
      },
    };
  }

  if (!chrome.commands) chrome.commands = {};
  chrome.commands.onCommand ||= event();
  chrome.commands.getAll ||= function (callback) {
    callback([]);
  };

  chrome.runtime.setUninstallURL ||= function (_url, callback) {
    callback?.();
  };
  chrome.tabs.create ||= function (_details, callback) {
    callback?.(null);
  };
  chrome.extension.isAllowedFileSchemeAccess ||= function (callback) {
    callback(false);
  };
})();
