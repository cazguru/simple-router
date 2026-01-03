/*  Simple Router.js by Caz.to
    Usage: Include <script src="/router.js"></script> and initialize:
    Router.init({container: '#app', linkSelector: '[data-router]'});
*/
(function () {
  const DEFAULTS = {
    container: "#app",
    linkSelector: "[data-router]",
    linkAttrName: "data-router",
    cache: true,
    prefetchOnHover: true,
  };

  const stateCache = new Map(); // url -> {html, title}

  const Router = {
    config: { ...DEFAULTS },

    // routes: { path, keys, regex, options }
    routes: [],
    loaderCache: new Map(),
    hooks: {
      beforeEach: [],
      afterEach: [],
      onError: [],
    },

    init(opts = {}) {
      this.config = { ...this.config, ...opts };
      this._bindClicks();
      this._bindForms();
      if (this.config.prefetchOnHover) this._bindPrefetch();
      window.addEventListener("popstate", this._onPopState.bind(this));

      // Save current content as initial state
      const containerEl = document.querySelector(this.config.container);
      const html = containerEl
        ? containerEl.innerHTML
        : document.body.innerHTML;
      const title = document.title;
      history.replaceState(
        { html, title, url: location.href },
        "",
        location.href
      );
      stateCache.set(location.href, { html, title });

      this._updateActiveLinks();
    },

    // alias for consistency with docs
    start(opts = {}) {
      this.init(opts);
      return this;
    },

    route(path, options = {}) {
      const { regex, keys } = this._pathToRegex(path);
      this.routes.push({ path, regex, keys, options });
      return this;
    },

    beforeEach(fn) {
      this.hooks.beforeEach.push(fn);
    },

    afterEach(fn) {
      this.hooks.afterEach.push(fn);
    },

    onError(fn) {
      this.hooks.onError.push(fn);
    },

    _matchesLocal(href) {
      try {
        const u = new URL(href, location.href);
        return u.origin === location.origin;
      } catch (e) {
        return false;
      }
    },

    _bindClicks() {
      document.addEventListener(
        "click",
        async (e) => {
          if (e.defaultPrevented) return;
          const el =
            e.target.closest(this.config.linkSelector) ||
            e.target.closest("[data-route],[data-href]");
          if (!el) return;

          // allow modifier keys and non-left clicks to open normally
          if (
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
          )
            return;

          let href =
            el.getAttribute("href") ||
            el.getAttribute("data-href") ||
            el.getAttribute("data-route");
          if (!href) return;
          if (!this._matchesLocal(href)) return; // let external links behave normally

          e.preventDefault();

          // run beforeEach hooks
          const full = new URL(href, location.href).href;
          const ctx = this._buildCtx(full);
          const proceed = await this._runBeforeHooks(ctx);
          if (proceed === false) return;
          if (typeof proceed === "string") return this.navigate(proceed);

          this.navigate(href);
        },
        { passive: false }
      );
    },

    _bindPrefetch() {
      const hoverHandler = (e) => {
        const el = e.target.closest(this.config.linkSelector);
        if (!el) return;
        // only prefetch if data-prefetch present or global prefetch enabled
        if (!this.config.prefetchOnHover && !el.hasAttribute("data-prefetch"))
          return;
        const href =
          el.getAttribute("href") ||
          el.getAttribute("data-href") ||
          el.getAttribute("data-route");
        if (!href) return;
        const full = new URL(href, location.href).href;
        if (stateCache.has(full) || this.loaderCache.has(full)) return;

        // if a route is registered, pre-run its loader
        const match = this._matchRoute(full);
        if (match && match.route.options.loader) {
          // initiate loader but don't await
          match.route.options
            .loader({ params: match.params, query: match.query })
            .then((data) => this.loaderCache.set(full, data))
            .catch(() => {});
          return;
        }

        // otherwise fetch HTML (non-blocking)
        fetch(full, { headers: { "X-Requested-With": "XMLHttpRequest" } })
          .then((r) => (r.ok ? r.text() : Promise.reject(r.statusText)))
          .then((text) => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, "text/html");
            const content = (
              doc.querySelector(this.config.container) || doc.body
            ).innerHTML;
            const title = doc.querySelector("title")?.innerText || "";
            stateCache.set(full, { html: content, title });
          })
          .catch(() => {});
      };
      document.addEventListener("mouseover", hoverHandler);
    },

    _bindForms() {
      document.addEventListener("submit", async (e) => {
        const form = e.target;
        if (!form || form.tagName !== "FORM") return;
        // intercept if marked or inside the app container
        if (
          !form.hasAttribute("data-router") &&
          !form.closest(this.config.container)
        )
          return;

        e.preventDefault();

        const method = (form.method || "GET").toUpperCase();
        const action = form.action || location.href;
        const headers = { "X-Requested-With": "XMLHttpRequest" };

        try {
          if (method === "GET") {
            const formData = new FormData(form);
            const params = new URLSearchParams(formData).toString();
            const url = params ? `${action}?${params}` : action;
            await this.navigate(url);
            return;
          }

          // POST or others: send via fetch
          const body = new FormData(form);
          const res = await fetch(action, { method, body, headers });
          const contentType = res.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const json = await res.json();
            // if there is a matching route, call its render with json
            const match = this._matchRoute(action);
            if (match && match.route.options.render) {
              const html = await match.route.options.render(json, {
                params: match.params,
                query: match.query,
              });
              const container = document.querySelector(this.config.container);
              this._patch(container, html);
              this._runScripts(container);
              this._updateActiveLinks();
              return;
            }
            // otherwise console.debug
            console.debug(json);
          } else {
            // treat as HTML and patch
            const text = await res.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, "text/html");
            const content = (
              doc.querySelector(this.config.container) || doc.body
            ).innerHTML;
            const title =
              doc.querySelector("title")?.innerText || document.title;
            const container = document.querySelector(this.config.container);
            this._patch(container, content);
            this._runScripts(container);
            document.title = title;
            history.pushState(
              { html: content, title, url: action },
              "",
              action
            );
            this._updateActiveLinks();
          }
        } catch (err) {
          this._callErrorHooks(err, { action, form });
          console.warn("Form router submit failed, falling back:", err);
        }
      });
    },

    async navigate(href, { replace = false, scrollTop = 0 } = {}) {
      const full = new URL(href, location.href).href;
      if (full === location.href) return;

      const container = document.querySelector(this.config.container);
      if (!container) {
        window.location.href = href;
        return;
      }

      // build context
      const ctx = this._buildCtx(full);

      try {
        // run beforeEach hooks
        const before = await this._runBeforeHooks(ctx);
        if (before === false) return;
        if (typeof before === "string") return this.navigate(before);

        // if route matched, use route pipeline
        const match = this._matchRoute(full);
        if (match && match.route.options) {
          const route = match.route;
          container.classList.add("router-loading");
          let data;

          // try loader cache first
          if (this.loaderCache.has(full)) data = this.loaderCache.get(full);

          try {
            if (!data && route.options.loader) {
              data = await route.options.loader({
                params: match.params,
                query: match.query,
              });
              // store in loader cache
              this.loaderCache.set(full, data);
            }

            // render
            if (route.options.render) {
              const html = await route.options.render(data, {
                params: match.params,
                query: match.query,
              });
              this._patch(
                container,
                typeof html === "string" ? html : String(html)
              );
            } else if (route.options.template) {
              this._patch(container, route.options.template);
            } else {
              // fallback to fetch the underlying HTML page
              const cached = stateCache.get(full);
              if (cached) {
                this._patch(container, cached.html);
                document.title = cached.title || document.title;
              } else {
                const res = await fetch(full, {
                  headers: { "X-Requested-With": "XMLHttpRequest" },
                });
                if (!res.ok) throw new Error("Network response not ok");
                const text = await res.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, "text/html");
                const content = (
                  doc.querySelector(this.config.container) || doc.body
                ).innerHTML;
                const title =
                  doc.querySelector("title")?.innerText || document.title;
                if (this.config.cache)
                  stateCache.set(full, { html: content, title });
                this._patch(container, content);
                document.title = title;
              }
            }

            this._runScripts(container);

            // push/replace history
            if (replace)
              history.replaceState(
                { html: container.innerHTML, title: document.title, url: full },
                "",
                full
              );
            else
              history.pushState(
                { html: container.innerHTML, title: document.title, url: full },
                "",
                full
              );

            this._updateActiveLinks();
            if (scrollTop !== false) window.scrollTo(0, scrollTop);
            await this._runAfterHooks({ to: ctx, from: null });
          } finally {
            container.classList.remove("router-loading");
          }

          return;
        }

        // if no route matched, fallback to HTML fetch (existing behavior)
        let cached = stateCache.get(full);
        if (!cached) {
          const res = await fetch(full, {
            headers: { "X-Requested-With": "XMLHttpRequest" },
          });
          if (!res.ok) throw new Error("Network response not ok");
          const text = await res.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(text, "text/html");
          const content = (doc.querySelector(this.config.container) || doc.body)
            .innerHTML;
          const title = doc.querySelector("title")?.innerText || document.title;
          cached = { html: content, title };
          if (this.config.cache) stateCache.set(full, cached);
        }

        // patch content (minimal DOM updates)
        this._patch(container, cached.html);

        // run any new scripts (only once)
        this._runScripts(container);
        document.title = cached.title || document.title;

        // push state
        if (replace)
          history.replaceState(
            { html: cached.html, title: cached.title, url: full },
            "",
            full
          );
        else
          history.pushState(
            { html: cached.html, title: cached.title, url: full },
            "",
            full
          );

        this._updateActiveLinks();
        if (scrollTop !== false) window.scrollTo(0, scrollTop);
      } catch (err) {
        this._callErrorHooks(err, { href: full });
        console.warn(
          "Router: fetch failed, falling back to full navigation",
          err
        );
        window.location.href = href;
      }
    },

    _onPopState(e) {
      const state = e.state;
      const container = document.querySelector(this.config.container);
      if (!container) return;
      if (state && state.html) {
        this._patch(container, state.html);
        document.title = state.title || document.title;
        this._runScripts(container);
        this._updateActiveLinks();
      } else {
        // try to navigate and replace state
        this.navigate(location.href, { replace: true });
      }
    },

    // --- routing helpers ---
    _pathToRegex(path) {
      // convert '/user/:id/*' into regex and key list
      const keys = [];
      // escape regexp special chars except ':' and '*'
      let pattern = path.replace(/([.+?^=!:${}()|\\])/g, "\\$1");
      pattern = pattern.replace(/\\\*/g, "(.*)");
      pattern = pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
        keys.push(key);
        return "([^/]+)";
      });
      const regex = new RegExp(`^${pattern}$`);
      return { regex, keys };
    },

    _matchRoute(fullUrl) {
      try {
        const url = new URL(fullUrl);
        const pathname = url.pathname;
        for (const r of this.routes) {
          const m = pathname.match(r.regex);
          if (m) {
            const params = {};
            r.keys.forEach(
              (k, i) => (params[k] = decodeURIComponent(m[i + 1] || ""))
            );
            const query = this._parseQuery(url.search);
            return { route: r, params, query, pathname };
          }
        }
        return null;
      } catch (e) {
        return null;
      }
    },

    _parseQuery(search) {
      const params = {};
      const sp = new URLSearchParams(search);
      for (const [k, v] of sp.entries()) params[k] = v;
      return params;
    },

    _buildCtx(full) {
      const url = new URL(full);
      return {
        url,
        path: url.pathname,
        query: this._parseQuery(url.search),
        full,
      };
    },

    async _runBeforeHooks(ctx) {
      for (const fn of this.hooks.beforeEach) {
        try {
          const res = await fn(ctx);
          if (res === false) return false;
          if (typeof res === "string") return res;
        } catch (err) {
          this._callErrorHooks(err, ctx);
          return false;
        }
      }
      return true;
    },

    async _runAfterHooks(info) {
      for (const fn of this.hooks.afterEach) {
        try {
          await fn(info);
        } catch (err) {
          this._callErrorHooks(err, info);
        }
      }
    },

    _callErrorHooks(err, ctx) {
      for (const fn of this.hooks.onError) {
        try {
          fn(err, ctx);
        } catch (e) {}
      }
    },

    // --- Small DOM diffing / patcher (no external libs) ---
    _patch(container, html) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      this._updateChildren(container, wrapper);
    },

    _isSameNode(oldNode, newNode) {
      if (oldNode.nodeType !== newNode.nodeType) return false;
      if (oldNode.nodeType === Node.TEXT_NODE) return true;
      if (oldNode.nodeType === Node.ELEMENT_NODE) {
        if (oldNode.tagName !== newNode.tagName) return false;
        const oldKey =
          oldNode.getAttribute && oldNode.getAttribute("data-router-key");
        const newKey =
          newNode.getAttribute && newNode.getAttribute("data-router-key");
        if (oldKey || newKey) {
          return oldKey && newKey && oldKey === newKey;
        }
        return true;
      }
      return false;
    },

    _updateAttributes(oldEl, newEl) {
      // Remove attributes not present
      Array.from(oldEl.attributes).forEach((attr) => {
        if (!newEl.hasAttribute(attr.name)) oldEl.removeAttribute(attr.name);
      });
      // Set/update new attributes
      Array.from(newEl.attributes).forEach((attr) => {
        if (oldEl.getAttribute(attr.name) !== attr.value) {
          oldEl.setAttribute(attr.name, attr.value);
        }
      });
    },

    _copyInputState(oldEl, newEl) {
      const tag = oldEl.tagName;
      if (tag === "INPUT") {
        if (oldEl.type === "checkbox" || oldEl.type === "radio") {
          newEl.checked = oldEl.checked;
        } else {
          newEl.value = oldEl.value;
        }
      } else if (tag === "TEXTAREA") {
        newEl.value = oldEl.value;
      } else if (tag === "SELECT") {
        newEl.selectedIndex = oldEl.selectedIndex;
      }
    },

    _execScriptsInNode(node) {
      // execute script tags found in node, but skip ones already marked executed
      const scripts = Array.from(
        node.querySelectorAll ? node.querySelectorAll("script") : []
      );
      scripts.forEach((old) => {
        if (old.dataset && old.dataset.routerExecuted) return;
        const n = document.createElement("script");
        Array.from(old.attributes).forEach((a) =>
          n.setAttribute(a.name, a.value)
        );
        if (old.src) {
          n.src = old.src;
          n.async = false;
          // mark executed after load
          n.onload = () => (n.dataset.routerExecuted = "1");
        } else {
          n.textContent = old.textContent;
          n.dataset.routerExecuted = "1";
        }
        old.parentNode.replaceChild(n, old);
      });
    },

    _patchNode(oldNode, newNode) {
      // preserve nodes explicitly marked
      if (
        oldNode.nodeType === Node.ELEMENT_NODE &&
        (oldNode.hasAttribute("data-preserve") ||
          newNode.hasAttribute("data-preserve"))
      ) {
        return; // do not touch preserved nodes
      }

      // text nodes
      if (
        oldNode.nodeType === Node.TEXT_NODE &&
        newNode.nodeType === Node.TEXT_NODE
      ) {
        if (oldNode.textContent !== newNode.textContent)
          oldNode.textContent = newNode.textContent;
        return;
      }

      // different types or tags or keys -> replace
      const oldKey =
        oldNode.getAttribute && oldNode.getAttribute("data-router-key");
      const newKey =
        newNode.getAttribute && newNode.getAttribute("data-router-key");
      if (
        !this._isSameNode(oldNode, newNode) ||
        (oldKey && newKey && oldKey !== newKey)
      ) {
        const clone = newNode.cloneNode(true);
        // try to preserve input state
        try {
          if (
            oldNode.nodeType === Node.ELEMENT_NODE &&
            clone.nodeType === Node.ELEMENT_NODE
          ) {
            this._copyInputState(oldNode, clone);
          }
        } catch (e) {}
        oldNode.parentNode.replaceChild(clone, oldNode);
        // execute any scripts inside the newly inserted content
        this._execScriptsInNode(clone);
        return;
      }

      // same tag/element: update attributes and children
      if (
        oldNode.nodeType === Node.ELEMENT_NODE &&
        newNode.nodeType === Node.ELEMENT_NODE
      ) {
        this._updateAttributes(oldNode, newNode);
        this._updateChildren(oldNode, newNode);
      }
    },

    _updateChildren(oldParent, newParent) {
      const oldChildren = Array.from(oldParent.childNodes);
      const newChildren = Array.from(newParent.childNodes);

      // map keyed old children for quick lookup
      const keyedOld = new Map();
      oldChildren.forEach((c) => {
        if (c.nodeType === Node.ELEMENT_NODE) {
          const k = c.getAttribute("data-router-key");
          if (k) keyedOld.set(k, c);
        }
      });

      let oldIndex = 0;
      newChildren.forEach((newChild) => {
        let oldChild = oldParent.childNodes[oldIndex];

        if (newChild.nodeType === Node.ELEMENT_NODE) {
          const key = newChild.getAttribute("data-router-key");
          if (key && keyedOld.has(key)) {
            const match = keyedOld.get(key);
            if (match !== oldChild) {
              oldParent.insertBefore(match, oldChild || null);
            }
            this._patchNode(match, newChild);
            // if we inserted, ensure subsequent positions align
            if (oldParent.childNodes[oldIndex] === match) oldIndex++;
            return;
          }
        }

        if (!oldChild) {
          // append new node
          const clone = newChild.cloneNode(true);
          oldParent.appendChild(clone);
          this._execScriptsInNode(clone);
          oldIndex++;
          return;
        }

        if (this._isSameNode(oldChild, newChild)) {
          this._patchNode(oldChild, newChild);
          oldIndex++;
          return;
        }

        // try lookahead for a same node within the remaining old children
        let foundIdx = -1;
        for (let j = oldIndex + 1; j < oldParent.childNodes.length; j++) {
          if (this._isSameNode(oldParent.childNodes[j], newChild)) {
            foundIdx = j;
            break;
          }
        }

        if (foundIdx > -1) {
          const nodeToMove = oldParent.childNodes[foundIdx];
          oldParent.insertBefore(nodeToMove, oldChild);
          this._patchNode(nodeToMove, newChild);
          oldIndex++;
          return;
        }

        // otherwise, replace the oldChild with newChild clone
        const clone = newChild.cloneNode(true);
        // try to copy input state before replacing
        try {
          if (
            oldChild.nodeType === Node.ELEMENT_NODE &&
            clone.nodeType === Node.ELEMENT_NODE
          ) {
            this._copyInputState(oldChild, clone);
          }
        } catch (e) {}
        oldParent.replaceChild(clone, oldChild);
        this._execScriptsInNode(clone);
        oldIndex++;
      });

      // remove any extra old children
      while (oldParent.childNodes.length > newChildren.length) {
        oldParent.removeChild(oldParent.lastChild);
      }
    },

    // run scripts inside container that haven't been executed yet
    _runScripts(container) {
      const scripts = Array.from(container.querySelectorAll("script"));
      scripts.forEach((old) => {
        if (old.dataset && old.dataset.routerExecuted) return;
        const n = document.createElement("script");
        Array.from(old.attributes).forEach((a) =>
          n.setAttribute(a.name, a.value)
        );
        if (old.src) {
          n.src = old.src;
          n.async = false; // preserve order
          n.onload = () => (n.dataset.routerExecuted = "1");
        } else {
          n.textContent = old.textContent;
          n.dataset.routerExecuted = "1";
        }
        old.parentNode.replaceChild(n, old);
      });
    },

    _updateActiveLinks() {
      const links = document.querySelectorAll(this.config.linkSelector);
      links.forEach((a) => {
        const href =
          a.getAttribute("href") ||
          a.getAttribute("data-href") ||
          a.getAttribute("data-route");
        if (!href) return;
        try {
          const full = new URL(href, location.href).href;
          a.classList.toggle("active", full === location.href);
        } catch (e) {}
      });
    },
  };

  window.Router = Router;
})();
