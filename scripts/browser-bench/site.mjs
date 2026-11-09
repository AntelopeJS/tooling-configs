import { createServer } from "node:http";

const ROW_COUNT = 200;

const LOGIN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body>
<main><h1>Sign in</h1>
<form method="get" action="/list.html">
<label for="email">Email address</label><input id="email" name="email" type="email">
<label for="password">Password</label><input id="password" name="password" type="password">
<button type="submit">Login</button>
</form></main></body></html>`;

const rows = Array.from(
  { length: ROW_COUNT },
  (_, index) =>
    `<li><span>Row ${index + 1} of ${ROW_COUNT}: order ${String(index + 1).padStart(5, "0")}</span> <button type="button" data-row="${index + 1}">Select row ${index + 1}</button></li>`,
).join("\n");

const LIST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orders</title>
<style>li{padding:6px;border-bottom:1px solid #ddd}li.on{background:#cde}</style></head><body>
<main><h1>Orders</h1><p role="status" aria-label="Selection" id="sel">Nothing selected</p>
<ul>${rows}</ul></main>
<script>
document.querySelector("ul").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  document.querySelectorAll("li.on").forEach((item) => item.classList.remove("on"));
  button.closest("li").classList.add("on");
  document.getElementById("sel").textContent = "Selected row " + button.dataset.row;
});
</script></body></html>`;

const DIALOG = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Actions</title></head><body>
<main><h1>Actions</h1>
<button type="button" id="open">Open dialog</button>
<button type="button" id="add">Add item</button>
<p role="status" aria-label="Items" id="items">Items: 0</p>
<p role="status" aria-label="Save result" id="saved" hidden></p>
<dialog id="dlg" aria-label="Rename"><form method="dialog">
<label for="name">Name</label><input id="name" name="name">
<button value="ok">Save</button></form></dialog></main>
<script>
let count = 0;
const dlg = document.getElementById("dlg");
document.getElementById("open").addEventListener("click", () => dlg.showModal());
document.getElementById("add").addEventListener("click", () => {
  count += 1;
  document.getElementById("items").textContent = "Items: " + count;
});
dlg.addEventListener("close", () => {
  const value = document.getElementById("name").value;
  setTimeout(() => {
    const saved = document.getElementById("saved");
    saved.textContent = "Saved " + value;
    saved.hidden = false;
  }, 100);
});
</script></body></html>`;

const PAGES = new Map([
  ["/login.html", LOGIN],
  ["/list.html", LIST],
  ["/dialog.html", DIALOG],
]);

/**
 * Whether the server listens on a TCP port rather than a pipe or not at all.
 *
 * @param {ReturnType<import("node:net").Server["address"]>} address
 * @returns {address is import("node:net").AddressInfo}
 */
function isTcpAddress(address) {
  return typeof address === "object" && address !== null;
}

/**
 * Serves the three benchmark pages from memory on a free loopback port.
 *
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>} The running site
 */
export function startSite() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const page = PAGES.get(path);
    if (page === undefined) {
      response.writeHead(path === "/favicon.ico" ? 204 : 404).end();
      return;
    }
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(page);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!isTcpAddress(address)) {
        throw new Error(`site server is not on a TCP port: ${address}`);
      }
      const { port } = address;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
