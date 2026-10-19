window.compatFixture = {
  save(value) {
    window.utools.dbStorage.setItem("value", value);
  },
  load() {
    return window.utools.dbStorage.getItem("value") || "";
  },
  notify(message) {
    window.utools.showNotification(message);
  }
};
