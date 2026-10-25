import type { BlockDefinition, Attribute } from './index.js';

/** Uses WordPress's existing PHP preview endpoint; no custom REST API or JSX compiler. */
export function editor(
	block: BlockDefinition,
	attributes: Record<string, Attribute>,
	dev: boolean,
	signature: string,
): string {
	return `(() => {
const metadata = ${JSON.stringify({ ...block.metadata, attributes })};
const controls = ${JSON.stringify(block.editor.controls ?? {})};
const { createElement: h, Fragment, useState, useEffect, useRef } = wp.element;
const { InspectorControls, useBlockProps } = wp.blockEditor;
const { PanelBody, TextControl, TextareaControl, ToggleControl, SelectControl, Notice } = wp.components;
const Preview = wp.serverSideRender.ServerSideRender || wp.serverSideRender;
const base = new URL('./', document.currentScript.src);
function Edit({ attributes: values, setAttributes }) {
  const [revision, setRevision] = useState('');
  const [errors, setErrors] = useState([]);
  const wrapper = useRef(null);
  useEffect(() => {
    if (!${dev}) return;
    let active = true;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch(new URL('../../../dev.json', base), { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const state = await response.json();
        if (!active) return;
        setErrors(state.errors || []);
        if (state.errors?.length) return;
        if (state.signatures[metadata.name] !== ${JSON.stringify(signature)}) { window.location.reload(); return; }
        setRevision(state.revision);
        const doc = wrapper.current?.ownerDocument;
        if (!doc) return;
        const url = new URL('./style.css', base);
        let link = Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).find(link => {
          const current = new URL(link.href);
          return current.origin === url.origin && current.pathname === url.pathname;
        });
        if (!link) { link = doc.createElement('link'); link.rel = 'stylesheet'; doc.head.appendChild(link); }
        url.searchParams.set('xph', state.revision);
        if (link.href !== url.href) link.href = url.href;
      } catch (error) { if (error.name !== 'AbortError') console.debug('XPH preview: waiting for a successful build.'); }
    }
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, []);
  const fields = Object.entries(metadata.attributes).flatMap(([name, schema]) => {
    if (controls[name] === false) return [];
    const common = { key: name, label: controls[name] || name };
    const value = values[name] ?? schema.default;
    if (schema.enum) return [h(SelectControl, { ...common, options: schema.enum.map((value, index) => ({ label: String(value), value: String(index) })),
      value: String(schema.enum.indexOf(value)), onChange: index => setAttributes({ [name]: schema.enum[Number(index)] }) })];
    if (schema.type === 'boolean') return [h(ToggleControl, { ...common, checked: !!value, onChange: value => setAttributes({ [name]: value }) })];
    if (schema.type === 'object' || schema.type === 'array') return [h(JSONControl, { ...common, value, type: schema.type, onChange: value => setAttributes({ [name]: value }) })];
    const numeric = schema.type === 'number' || schema.type === 'integer';
    return [h(TextControl, { ...common, type: numeric ? 'number' : 'text', step: schema.type === 'integer' ? 1 : 'any', value: value ?? '',
      onChange: value => { if (!numeric) setAttributes({ [name]: value }); else if (value !== '' && Number.isFinite(Number(value))) setAttributes({ [name]: schema.type === 'integer' ? Math.trunc(Number(value)) : Number(value) }); } })];
  });
  return h(Fragment, null,
    h(InspectorControls, null, h(PanelBody, { title: metadata.title }, fields)),
    h('div', useBlockProps({ ref: wrapper }),
      errors.length ? h(Notice, { status: 'error', isDismissible: false }, errors.join('\\n')) : null,
      h(Preview, { key: revision, block: metadata.name, attributes: values, skipBlockSupportAttributes: true })));
}
function JSONControl({ value, onChange, type, ...props }) {
  const [text, setText] = useState(JSON.stringify(value ?? (type === 'array' ? [] : {}), null, 2));
  const [error, setError] = useState('');
  useEffect(() => { setText(JSON.stringify(value ?? (type === 'array' ? [] : {}), null, 2)); setError(''); }, [value, type]);
  return h(TextareaControl, { ...props, value: text, help: error, onChange: text => {
    setText(text);
    try { const parsed = JSON.parse(text); if (type === 'array' ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected ' + type); setError(''); onChange(parsed); }
    catch (error) { setError(error.message); }
  } });
}
wp.blocks.registerBlockType(metadata.name, { ...metadata, edit: Edit, save: () => null });
})();\n`;
}
