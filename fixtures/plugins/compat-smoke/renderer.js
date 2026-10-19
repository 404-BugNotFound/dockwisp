const payload = document.querySelector("#payload");
const value = document.querySelector("#value");

window.utools.onPluginEnter((action) => {
  payload.textContent = JSON.stringify(action, null, 2);
  value.value = window.compatFixture.load();
});

document.querySelector("#save").addEventListener("click", () => {
  window.compatFixture.save(value.value);
});

document.querySelector("#notify").addEventListener("click", () => {
  window.compatFixture.notify("Dockwisp 插件 API 可用");
});
