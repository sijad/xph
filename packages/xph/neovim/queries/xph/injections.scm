; Adapted from nvim-treesitter Astro injections (Apache-2.0).
; See nvim-treesitter-LICENSE.txt. Modified to select PHP for server blocks.
; Keep this separate from Astro's injections: its unconditional TypeScript
; script rule would also parse PHP bodies as TypeScript.
(frontmatter
  (frontmatter_js_block) @injection.content
  (#set! injection.language "typescript"))

(attribute_interpolation
  (attribute_js_expr) @injection.content
  (#set! injection.language "typescript"))

(attribute
  (attribute_backtick_string) @injection.content
  (#set! injection.language "typescript"))

(html_interpolation
  (permissible_text) @injection.content
  (#set! injection.language "typescript"))

(script_element
  (start_tag) @_tag
  (raw_text) @injection.content
  (#xph-script-language! @_tag))

(style_element
  (raw_text) @injection.content
  (#set! injection.language "css"))
