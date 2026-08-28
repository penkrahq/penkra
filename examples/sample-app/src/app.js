import { permissions, settings as appSettings, tab } from "@penkra/sdk/tab";
import { createAppBar, createIcon } from "@penkra/ui";
import "@penkra/ui/tokens.css";
import "@penkra/ui/app-bar.css";
import "./styles.css";
import { readableError, routeFromHash } from "./model";

const root = document.querySelector("#app");
let pendingNavigation = null;
let notice = null;
let displayName = "from Sample";

tab.onNavigate(async ({ route, state }, { signal }) => {
  if (route !== "/notes/new") throw new Error(`Unsupported route: ${route}`);
  location.hash = "#home";
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pendingNavigation = {
      text: typeof state?.text === "string" ? state.text : "",
      resolve,
      abort,
      signal,
    };
    render();
  });
});
window.addEventListener("hashchange", render);
void appSettings.get("display-name").then(
  (value) => {
    displayName = value;
    render();
  },
  (cause) => {
    notice = readableError(cause);
    render();
  },
);

function render() {
  const route = routeFromHash(location.hash);
  root.replaceChildren();
  if (route !== "focus") root.append(makeBar(route));
  const main = document.createElement("main");
  if (notice) main.append(message(notice));
  if (route === "focus")
    main.innerHTML =
      "<h1>Focus canvas</h1><p>This page deliberately omits the App Bar.</p><a href='#home'>Return</a>";
  else if (route === "settings") main.append(settings());
  else {
    const heading = document.createElement("h1");
    heading.textContent = `Hello ${displayName}`;
    main.append(
      heading,
      paragraph("Theme tokens adapt automatically to Penkra appearance."),
      link("#focus", "Open focus canvas"),
    );
    if (pendingNavigation) main.append(noteEditor());
  }
  root.append(main);
}

function makeBar(route) {
  return createAppBar({
    leading: [
      {
        key: "home",
        label: "Home",
        icon: () => createIcon("back"),
        onActivate: () => {
          location.hash = "#home";
        },
      },
    ],
    center: { kind: "display", text: route === "settings" ? "Settings" : "Sample" },
    trailing: [
      {
        key: "settings",
        label: "Settings",
        icon: () => createIcon("more"),
        onActivate: () => {
          location.hash = "#settings";
        },
      },
    ],
  }).element;
}

function settings() {
  const section = document.createElement("section");
  const label = document.createElement("label");
  label.textContent = "Display name ";
  const input = document.createElement("input");
  input.value = displayName;
  input.addEventListener("change", async () => {
    try {
      await appSettings.set("display-name", input.value);
      displayName = input.value;
      notice = "Display name saved for this Space.";
    } catch (cause) {
      notice = readableError(cause);
    }
    render();
  });
  label.append(input);
  const button = document.createElement("button");
  button.textContent = "Request network permission";
  button.addEventListener("click", async () => {
    try {
      notice = `network-fetch is ${(await permissions.request("network-fetch")).state}`;
    } catch (cause) {
      notice = readableError(cause);
    }
    render();
  });
  section.append(label, button);
  return section;
}

function noteEditor() {
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.value = pendingNavigation.text;
  const save = document.createElement("button");
  save.textContent = "Save";
  form.append(input, save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const pending = pendingNavigation;
    pendingNavigation = null;
    pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve({ saved: input.value.trim().length > 0 });
    render();
  });
  return form;
}

function message(text) {
  const value = document.createElement("p");
  value.textContent = text;
  value.setAttribute("role", "status");
  return value;
}
function paragraph(text) {
  const value = document.createElement("p");
  value.textContent = text;
  return value;
}
function link(href, text) {
  const value = document.createElement("a");
  value.href = href;
  value.textContent = text;
  return value;
}
