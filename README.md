# Simple Router
A Simple JavaScript Router Library, that lets you navigate between web pages without full page reload and converts your site to a Single Page Application 🤯

## Installation

Include the router script in your HTML file:

```html
<script src="router.js"></script>
```

## Usage

Initialize the router with the container id

```javascript
Router.init({
  container: "#container",
  linkSelector: "[data-router]",
});
```

## Routing Links

Use the `data-route` attribute on links to define routes:

```html
<a href="/page.html" data-router>Go to Page</a>
```

## Routing Forms

Use the `data-route` attribute on forms:

```html
<form action="/submit" data-router method="POST">
  <input type="text" name="username" />
  <button type="submit">Submit</button>
</form>
```

## Default Settings

These are the default settings. Can be found in router.js

```javascript
const DEFAULTS = {
  container: "#app",
  linkSelector: "[data-router]",
  linkAttrName: "data-router",
  cache: true,
  prefetchOnHover: true,
};
```
