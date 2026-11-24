function getGlobalApi() {
  if (typeof wx !== "undefined") return wx;
  if (typeof my !== "undefined") return my;
  if (typeof tt !== "undefined") return tt;
  // TCMPP
  try {
    if (typeof tx !== "undefined") return tx;
  } catch (e) {}
  return null;
}

function formatJson(val) {
  if (val === undefined || val === null) return "";
  if (typeof val === "string") {
    try {
      return JSON.stringify(JSON.parse(val.trim()), null, 2);
    } catch (e) {
      return val;
    }
  }
  try {
    return JSON.stringify(val, null, 2);
  } catch (e) {
    return String(val);
  }
}

function generateCurl(url, method, headers, data) {
  headers = headers || {};
  let curl = "curl -X " + method.toUpperCase() + ' "' + url + '"';
  Object.keys(headers).forEach(function (key) {
    curl += ' -H "' + key + ": " + String(headers[key]).replace(/"/g, '\\"') + '"';
  });
  if (data !== undefined && data !== null) {
    var dataStr = typeof data === "object" ? JSON.stringify(data) : String(data);
    curl += " -d '" + dataStr.replace(/'/g, "'\\''") + "'";
  }
  return curl;
}

function formatTime(ts) {
  var d = new Date(ts);
  var pad = function (n) {
    return String(n).padStart(2, "0");
  };
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function getStatusClass(status) {
  if (status === undefined || status === "pending") return "pending";
  if (status === "fail" || (typeof status === "number" && status >= 400)) return "error";
  if (status === "success") return "success";
  return "success";
}

function methodClass(method) {
  switch (String(method).toUpperCase()) {
    case "GET":
      return "get";
    case "POST":
      return "post";
    case "PUT":
      return "put";
    case "DELETE":
      return "delete";
    case "NATIVE":
      return "native";
    case "UPLOAD":
    case "DOWNLOAD":
      return "upload";
    default:
      return "default";
  }
}

function isNetworkLog(log) {
  if (!log) return false;
  if (log.type === "native") return false;
  return (
    log.type === "network" ||
    log.type === "http" ||
    log.type === "upload" ||
    log.type === "download" ||
    !log.type
  );
}

var PAGE_SIZE = 40;

/**
 * Lightweight list-row projection sent via setData for the list view.
 * Keeps headers and request/response bodies out of setData to avoid bridge bloat.
 */
function toListItem(log) {
  return {
    id: log.id,
    method: log.method,
    methodClass: methodClass(log.method),
    status: log.status,
    statusClass: getStatusClass(log.status),
    url: typeof log.url === "object" ? JSON.stringify(log.url) : log.url,
    timeLabel: formatTime(log.startTime),
    duration: log.duration,
  };
}

/**
 * Enrich a single ChuckerLog lazily when the user opens the detail view.
 */
function enrichLog(log) {
  return Object.assign({}, log, {
    isNetwork: isNetworkLog(log),
    url: typeof log.url === "object" ? JSON.stringify(log.url) : log.url,
    timeLabel: formatTime(log.startTime),
    startTimeLabel: new Date(log.startTime).toLocaleString(),
    statusClass: getStatusClass(log.status),
    methodClass: methodClass(log.method),
    requestHeadersText:
      log.requestHeaders && Object.keys(log.requestHeaders).length
        ? formatJson(log.requestHeaders)
        : "",
    requestDataText: log.requestData != null ? formatJson(log.requestData) : "",
    responseHeadersText:
      log.responseHeaders && Object.keys(log.responseHeaders).length
        ? formatJson(log.responseHeaders)
        : "",
    responseDataText: log.responseData != null ? formatJson(log.responseData) : "",
  });
}

function getStore() {
  var g =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof global !== "undefined"
        ? global
        : typeof window !== "undefined"
          ? window
          : {};
  return g.__CHUCKER_STORE__;
}

Page({
  data: {
    // Total number of logs in the store
    totalCount: 0,
    // Visible lightweight rows after filter/search + progressive windowing
    filteredLogs: [],
    hasMore: false,
    // 'all' | 'network' | 'native'
    filterType: "all",
    searchQuery: "",
    // 'list' | 'detail'
    view: "list",
    selectedLog: null,
    // 'overview' | 'request' | 'response'
    detailTab: "overview",
    errorCount: 0,
  },

  _unsubscribe: null,
  _visibleCount: PAGE_SIZE,
  _filteredTotal: 0,

  onLoad: function () {
    var self = this;
    var store = getStore();

    if (!store) {
      console.warn("[miniapp-chucker] Store not found. Did you call initChucker() in app.js?");
      return;
    }

    this._unsubscribe = store.subscribe(function (logs) {
      self._onLogsUpdate(logs);
    });
  },

  onUnload: function () {
    if (typeof this._unsubscribe === "function") {
      this._unsubscribe();
    }
  },

  // ──────────────────────────────────────────────
  // Internal: update displayed logs
  // ──────────────────────────────────────────────
  _onLogsUpdate: function (logs) {
    // When detail view is open, only refresh the selected log if it changed;
    // defer rebuilding the list until the user navigates back.
    if (this.data.view === "detail" && this.data.selectedLog) {
      var selectedId = this.data.selectedLog.id;
      var updated = logs.find(function (l) {
        return l.id === selectedId;
      });
      if (
        updated &&
        (updated.status !== this.data.selectedLog.status ||
          updated.duration !== this.data.selectedLog.duration)
      ) {
        this.setData({ selectedLog: enrichLog(updated) });
      }
      return;
    }

    var filterType = this.data.filterType;
    var searchQuery = (this.data.searchQuery || "").trim().toLowerCase();

    var filtered = logs.filter(function (log) {
      if (filterType === "network" && !isNetworkLog(log)) return false;
      if (filterType === "native" && log.type !== "native") return false;
      if (searchQuery) {
        var inUrl = log.url && String(log.url).toLowerCase().indexOf(searchQuery) !== -1;
        var inHeaders =
          log.requestHeaders &&
          JSON.stringify(log.requestHeaders).toLowerCase().indexOf(searchQuery) !== -1;
        var inBody =
          log.requestData &&
          JSON.stringify(log.requestData).toLowerCase().indexOf(searchQuery) !== -1;
        if (!inUrl && !inHeaders && !inBody) return false;
      }
      return true;
    });

    var errorCount = logs.filter(function (log) {
      return (
        log.status === "fail" ||
        log.status === "error" ||
        (typeof log.status === "number" && log.status >= 400)
      );
    }).length;

    this._filteredTotal = filtered.length;
    var slice = filtered.slice(0, this._visibleCount);

    this.setData({
      totalCount: logs.length,
      filteredLogs: slice.map(toListItem),
      hasMore: filtered.length > slice.length,
      errorCount: errorCount,
    });
  },

  onLoadMore: function () {
    if (this._visibleCount >= this._filteredTotal) return;
    this._visibleCount += PAGE_SIZE;
    var store = getStore();
    if (store) this._onLogsUpdate(store.getLogs());
  },

  onSetFilter: function (e) {
    var type = e.currentTarget.dataset.type;
    this._visibleCount = PAGE_SIZE;
    this.setData(
      { filterType: type },
      function () {
        var store = getStore();
        if (store) this._onLogsUpdate(store.getLogs());
      }.bind(this),
    );
  },

  onSearch: function (e) {
    this._visibleCount = PAGE_SIZE;
    this.setData(
      { searchQuery: e.detail.value },
      function () {
        var store = getStore();
        if (store) this._onLogsUpdate(store.getLogs());
      }.bind(this),
    );
  },

  onClearSearch: function () {
    this._visibleCount = PAGE_SIZE;
    this.setData(
      { searchQuery: "" },
      function () {
        var store = getStore();
        if (store) this._onLogsUpdate(store.getLogs());
      }.bind(this),
    );
  },

  onTapLog: function (e) {
    var id = e.currentTarget.dataset.id;
    var store = getStore();
    if (!store) return;
    var log = store.getLogs().find(function (l) {
      return l.id === id;
    });
    if (!log) return;
    this.setData({
      view: "detail",
      selectedLog: enrichLog(log),
      detailTab: "overview",
    });
  },

  onBack: function () {
    this.setData(
      { view: "list", selectedLog: null },
      function () {
        var store = getStore();
        if (store) this._onLogsUpdate(store.getLogs());
      }.bind(this),
    );
  },

  onSetDetailTab: function (e) {
    this.setData({ detailTab: e.currentTarget.dataset.tab });
  },

  onClear: function () {
    var api = getGlobalApi();
    if (!api) return;
    var self = this;
    api.showModal({
      title: "Clear Logs",
      content: "Delete all logged requests?",
      success: function (res) {
        if (res.confirm) {
          var store = getStore();
          if (store) store.clear();
          self.setData({ view: "list", selectedLog: null });
        }
      },
    });
  },

  onExport: function () {
    var self = this;
    var api = getGlobalApi();
    var store = getStore();
    if (!store) return;
    if (!store.getLogs().length) {
      if (api) api.showToast({ title: "No logs yet", icon: "none", duration: 1500 });
      return;
    }
    if (!api) return;
    api.showActionSheet({
      itemList: ["Api Network", "Native"],
      success: function (res) {
        var isApi = res.tapIndex === 0;
        var picked = store.getLogs().filter(function (l) {
          if (l.type === "native") return !isApi;
          return isApi && (!l.type || ["network", "http", "upload", "download"].indexOf(l.type) !== -1);
        });
        if (!picked.length) {
          api.showToast({
            title: isApi ? "No API logs" : "No native logs",
            icon: "none",
            duration: 1500,
          });
          return;
        }
        var text = picked
          .slice()
          .reverse()
          .map(function (l) {
            return l.type === "native"
              ? "NATIVE " + l.url + " " + JSON.stringify(l.requestData || {})
              : generateCurl(l.url, l.method || "GET", l.requestHeaders, l.requestData);
          })
          .join("\n\n");
        self._copyToClipboard(text, "Export copied!");
      },
    });
  },

  onCopyUrl: function () {
    var log = this.data.selectedLog;
    if (log && log.url) this._copyToClipboard(log.url, "URL Copied!");
  },

  onCopyCurl: function () {
    var log = this.data.selectedLog;
    if (!log) return;
    var curl = generateCurl(log.url, log.method, log.requestHeaders, log.requestData);
    this._copyToClipboard(curl, "cURL Copied!");
  },

  onCopyRequestHeaders: function () {
    var log = this.data.selectedLog;
    if (log && log.requestHeadersText) this._copyToClipboard(log.requestHeadersText, "Copied!");
  },

  onCopyRequestBody: function () {
    var log = this.data.selectedLog;
    if (log && log.requestDataText) this._copyToClipboard(log.requestDataText, "Copied!");
  },

  onCopyResponseHeaders: function () {
    var log = this.data.selectedLog;
    if (log && log.responseHeadersText) this._copyToClipboard(log.responseHeadersText, "Copied!");
  },

  onCopyResponseBody: function () {
    var log = this.data.selectedLog;
    if (log && log.responseDataText) this._copyToClipboard(log.responseDataText, "Copied!");
  },

  _copyToClipboard: function (text, title) {
    var api = getGlobalApi();
    if (!api) return;
    api.setClipboardData({
      data: text,
      success: function () {
        api.showToast({ title: title || "Copied!", icon: "success", duration: 1500 });
      },
    });
  },
});
