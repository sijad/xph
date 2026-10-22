# Syntax reference

## Component data

### Build-time code

Put imports, constants, and helper functions between `---` fences.
They run during compilation. Helper calls in templates also run at build time
when all arguments are build-time values; their results must be serializable.
Build-time code also supports expression statements, `if`,
`for`, `for…of`, and `while`.

```xph
---
const name = 'xph';
function upper(value: string) {
	return value.toUpperCase();
}
---

<h1>{upper(name)}</h1>
```

### Typed props

Declare inputs with `Props` and read them through `props`.
Contracts support primitives, arrays, records, aliases, and unions, including
imported and generic types that resolve to supported shapes. Types are checked
at build time; PHP values are not validated at runtime.

```xph
---
export interface Props {
	title: string;
	size?: 'small' | 'large';
	items: { name: string; price: number }[];
}
---

<h1>{props.title}</h1>
```

### PHP server data

One server script runs before each render. Read `$props` and return
an array matching `Server`. Use PHP for request-time work; omit
`<?php` tags.

Set `debug: true` to preserve original exceptions and include source
diagnostics. It defaults to `false`.

```xph
---
export interface Server {
	year: string;
}
---

<script is:server>
	return [
		'year' => date('Y'),
	];
</script>

<p>{server.year}</p>
```

### PHP server methods

Declare top-level methods or function properties on `Server`, then
return PHP closures. Parameters and return values need explicit types;
optional/rest parameters and nested methods are unsupported. Calls run when the
expression renders. PHP numeric parameters should accept `float` or
`int|float`.

```xph
---
export interface Server {
	upper(value: string): string;
}
---

<script is:server>
	return [
		'upper' => static fn(string $value): string => strtoupper($value),
	];
</script>

<h1>{server.upper('hello')}</h1>
```

## Expressions & control flow

### Text & expressions

Put values or expressions in braces to insert text, join strings, or calculate
numbers with `+ - * / **`. Dynamic text is HTML-escaped. Strings and
numbers render as text; booleans, `null`, and
`undefined` render nothing. Arrays and objects must be used in a
list, spread, or other supported expression.

```xph
<h1>{props.title}</h1>
<p>{'Hello, ' + props.name}</p>
<p>Total: {props.price * props.quantity}</p>
```

### Property access & fallbacks

Use dot or bracket access, including array indexes. Optional access
`?.` handles missing values; `??` supplies a fallback for
null or undefined. Array `length` is supported; string indexing and
string length are not.

```xph
<p>{props.user?.name ?? 'Guest'}</p>
<p>{props.items[0] ?? 'Empty'}</p>
<p>{props.items.length}</p>
```

### Operators

Use `+ - * / **` and `< <= > >=` with numbers;
`+` also joins two strings. Use `=== !==` for scalar
equality, `! && ||` for booleans, and unary
`+ -` for numbers. Parentheses group expressions.

```xph
<p>{(props.price * props.quantity) + 5}</p>
<p>{props.status === 'ready' ? 'Ready' : 'Waiting'}</p>
<button disabled={!props.ready || props.busy}>Save</button>
```

### Conditional content

Use `&&` to show content, `||` to show a fallback,
or a ternary to choose a branch. Conditions must be booleans; compare counts
explicitly.

```xph
{props.visible && <p>Hello!</p>}
{props.visible || <p>Nothing to show.</p>}
{props.signedIn ? <a href="/account">Account</a> : <p>Sign in</p>}
```

### Lists

Use `.map()` with an expression-bodied arrow callback. Its optional
second parameter is the zero-based index. Prepare filtered or sorted
request-time lists in PHP.

```xph
<ul>
	{props.items.map((item, index) => <li>{index + 1}. {item}</li>)}
</ul>
{props.items.length === 0 && <p>No items yet.</p>}
```

## HTML & attributes

### HTML, SVG & comments

Write ordinary HTML, SVG, custom elements, and HTML comments. Comments remain in
the output. URL attributes are checked for unsafe schemes; invalid attributes,
event handlers, and `srcdoc` are rejected.

```xph
<!doctype html>
<!-- This comment appears in the rendered HTML. -->
<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /></svg>
<my-element data-label="Hello"></my-element>
```

### HTML whitespace

Static whitespace is compressed by default; dynamic values and
whitespace-sensitive content such as `<pre>` are preserved. Set
`compressHTML: false` to keep template spacing as written.

```xph
<!-- Expressions preserve the supplied whitespace. -->
<pre>{'First line\n  Indented line'}</pre>
```

### HTML attributes

Use native names such as `class` and `for`. Boolean HTML
attributes use presence; ordinary false/nullish values omit the attribute. ARIA
and data booleans become `"true"` or `"false"`. Empty
strings and zero are preserved.

```xph
<label for="name">Name</label>
<input id="name" disabled={props.disabled} />
<p aria-hidden={props.disabled}>Status</p>
```

### Attribute & prop spreads

Spread an object onto HTML or a component. Later values override earlier ones.
HTML attribute values must be scalar; component props can contain arrays and
records matching their contracts.

```xph
<button {...props.attrs} id="save">Save</button>
<Card {...{ title: props.title }} />
```

### Dynamic HTML tags

Use an uppercase binding or a property containing an HTML tag string. Dynamic
tags support attributes, content directives, and scoped styles. They select HTML
elements, not components; executable or document-changing tags such as script,
style, and iframe are restricted.

```xph
---
export interface Props { tag: 'section' | 'article' }
const Tag = 'section';
---

<Tag>Fixed tag</Tag>
<props.tag>Tag from props</props.tag>
```

## Components & slots

### Components

Import a `.xph` component with a default binding and pass its
declared props. Imports must stay inside your project; circular component
imports are rejected.

```xph
---
import Card from './Card.xph';
---

<Card title="Hello" />
```

### Recursive components

Use `<xph.self>` to render the current component without an
import. Props are checked against its `Props` interface. Add a
condition that stops recursion.

```xph
---
export interface Props { depth: number }
---

<p>{props.depth}</p>
{props.depth > 0 && <xph.self depth={props.depth - 1} />}
```

### Default slots

In the child component, use `<slot>` for content passed between
its opening and closing tags. Optional fallback content appears when the slot is
not supplied.

```xph
<!-- Card.xph -->
<article><slot>Nothing here yet.</slot></article>

<!-- Parent (imports Card) -->
<Card><p>Inside the card</p></Card>
```

### Named slots

Match a child’s literal `slot` name with
`<slot name="…">`. Assigned elements must be direct children of
an imported component. Multiple children with the same name render in order.

```xph
<!-- Card.xph -->
<slot name="header">Default heading</slot>

<!-- Parent (imports Card) -->
<Card><h2 slot="header">News</h2></Card>
```

### Rendering slots

`xph.slots.render(name, args?)` renders a slot to an HTML string at
PHP request time. Missing slots return an empty string. Interpolation escapes
the result; use `set:html` to insert its markup. Each call renders
the slot again.

```xph
<div set:html={xph.slots.render('default')} />
<header set:html={xph.slots.render('header')} />
```

### Slot callbacks

Pass positional arguments as an array to `xph.slots.render()`. The
parent supplies an expression-bodied callback with explicitly typed parameters.
For a named callback slot, wrap it in `<Fragment slot="…">`.
Ordinary slot content ignores arguments; callback argument types are not checked
across components.

```xph
<!-- List.xph (items: string[] in Props) -->
{props.items.map(item => (
	<p set:html={xph.slots.render('default', [item])} />
))}

<!-- Parent (imports List) -->
<List items={['Hello', 'World']}>
	{(item: string) => <strong>{item}</strong>}
</List>
```

### Fragments

Group elements without adding an HTML wrapper using `<>` or
`<Fragment>`. Built-in `Fragment` accepts only an
optional `slot` attribute, useful for grouping named content.

```xph
<>
	<h2>Title</h2>
	<p>Details</p>
</>

<Card>
	<Fragment slot="header">
		<h2>News</h2>
		<p>Today’s updates</p>
	</Fragment>
</Card>
```

## Template directives

### Conditional classes

`class:list` combines strings, numbers, nested arrays, and truthy
object keys with an ordinary `class`. False, nullish, and zero
entries are skipped. On components it passes the resulting string as a
`class` prop.

```xph
<div class="panel" class:list={[
	'rounded', ['bordered'], { active: props.active },
]} />
```

### Text & HTML directives

`set:text` inserts escaped text; `set:html` inserts
trusted or sanitized HTML without escaping. Use one directive on an HTML element
without children. They do not work on components, slots, Fragment, scripts, or
styles.

```xph
<h2 set:text={props.title} />
<div set:html={props.html} />
```

## Styles & browser scripts

### Scoped & global CSS

`<style>` scopes selectors and keyframe names to the component.
`is:global` disables scoping. CSS is bundled into external assets;
use PHP’s `\Xph\assets()` to include them, as shown in Getting
Started.

```xph
<style>
	h1 { color: olive; }
</style>
<style is:global>
	body { margin: 0; }
</style>
```

### CSS scoping strategies

Set `scopedStyleStrategy` to `'attribute'` (default),
`'class'`, or `'where'`. Use `'where'` to scope
styles without adding selector specificity, making them easier to override.

```typescript
// xph.config.ts
export default {
	srcDir: 'src',
	scopedStyleStrategy: 'where',
};
```

### Browser scripts & events

Plain scripts run in the browser and support TypeScript and imports. Use event
listeners instead of HTML event-handler attributes. Scripts are bundled into
external assets; include their URLs through `\Xph\assets()`.

```xph
<button id="save">Save</button>
<script>
	document.querySelector('#save')?.addEventListener('click', () => {
		console.log('Saved');
	});
</script>
```

### Inline scripts & styles

Add `is:inline` to render a script or style in place. Content and
static attributes stay as written; imports and URLs are left unchanged. Inline
assets skip bundling, type checking, CSS scoping, and deduplication, and are
excluded from `\Xph\assets()`. Use plain JavaScript; dynamic
attributes are unsupported.

```xph
<script is:inline>
	console.log('Hello');
</script>

<script is:inline src="/browser.js" defer></script>

<style is:inline>
	body { margin: 0; }
</style>
```

### Passing data to the browser

Browser scripts cannot access `props`, `server`, or
frontmatter bindings. Pass scalar data through HTML data attributes and read it
from the DOM. Runtime interpolation inside scripts and styles is unsupported.

```xph
<p id="greeting" data-name={props.name}></p>
<script>
	const el = document.querySelector<HTMLElement>('#greeting');
	if (el) el.textContent = 'Hello, ' + el.dataset.name;
</script>
```
