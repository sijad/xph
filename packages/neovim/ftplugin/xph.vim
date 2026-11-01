if exists('b:did_ftplugin')
  finish
endif
let b:did_ftplugin = 1

" Match Neovim's Astro ftplugin, including its HTML and JavaScript pairs.
setlocal matchpairs+=<:>
let b:undo_ftplugin = 'setlocal matchpairs<'

if exists('g:loaded_matchit')
  let b:match_ignorecase = 0
  let b:match_words = '\<do\>:\<while\>,' .
        \ '<\@<=\([^ \t>/]\+\)\%(\s\+[^>]*\%([^/]>\|$\)\|>\|$\):<\@<=/\1>,' .
        \ '<\@<=\%([^ \t>/]\+\)\%(\s\+[^/>]*\|$\):/>' .
        \ '<!--:-->,' .
        \ '<:>,' .
        \ '<\@<=[ou]l\>[^>]*\%(>\|$\):<\@<=li\>:<\@<=/[ou]l>,' .
        \ '<\@<=dl\>[^>]*\%(>\|$\):<\@<=d[td]\>:<\@<=/dl>,' .
        \ '<\@<=\([^/!][^ \t>]*\)[^>]*\%(>\|$\):<\@<=/\1>'
  let b:undo_ftplugin .= ' | unlet! b:match_words b:match_ignorecase'
endif
