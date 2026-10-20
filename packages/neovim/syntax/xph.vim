if exists('b:current_syntax')
  finish
endif

" Reuse Neovim's Astro syntax with TypeScript enabled without changing user options.
let s:typescript = get(g:, 'astro_typescript', v:null)
try
  let g:astro_typescript = 'enable'
  runtime! syntax/astro.vim
finally
  if s:typescript is v:null
    unlet g:astro_typescript
  else
    let g:astro_typescript = s:typescript
  endif
endtry
unlet! b:current_syntax
syntax include @xphPHP syntax/php.vim
unlet! b:current_syntax

" PHP's top-level cluster handles snippets without <?php tags. Attribute order,
" quote style and multiline opening tags are accepted. Contained PHP strings and
" comments protect apparent closing tags inside PHP code.
syntax region xphPHP matchgroup=htmlTag
      \ start=+<script\>\%(\_[^>]*\_sserver\%(\_s\|>\)\)\@=\%(\_[^>]*\_slang\s*=\s*\%('php'\|"php"\|php\ze\%(\_s\|>\)\)\)\@=\_[^>]*>+
      \ end=+</script\s*>+
      \ contains=@phpClTop
      \ containedin=htmlHead,htmlBody,htmlBold,htmlItalic,htmlLink,htmlDiv,astroJavaScriptExpression
syntax sync fromstart
let b:current_syntax = 'xph'
