local function test()
  local original_rtp = vim.opt.runtimepath:get()
  vim.opt.runtimepath = { vim.env.XPH_NVIM_RUNTIME, vim.env.VIMRUNTIME }
  vim.cmd('syntax on')
  vim.bo.syntax = 'xph'
  assert(not require('xph.treesitter').start(0), 'missing parsers did not trigger fallback')
  assert(vim.bo.syntax == 'xph', 'fallback removed Vim syntax')
  vim.opt.runtimepath = original_rtp
  vim.opt.runtimepath:prepend(vim.env.XPH_NVIM_TS_RUNTIME)
  vim.opt.runtimepath:prepend(vim.env.XPH_NVIM_RUNTIME)
  vim.cmd('syntax on')
  local source = {
    '---',
    'export interface Props { title: string }',
    '---',
    '<script server lang="php">',
    '$title = "Hello";',
    'return ["title" => $title];',
    '</script>',
    '<h1>{props.title}</h1>',
    '<script>',
    'const count: number = 1;',
    '</script>',
    '<style>',
    'h1 { color: red }',
    '</style>',
  }
  vim.api.nvim_buf_set_lines(0, 0, -1, false, source)
  vim.bo.filetype = 'xph'
  vim.bo.syntax = 'xph'
  local astro_query = vim.treesitter.query.get('astro', 'injections')
  assert(require('xph.treesitter').start(0), 'Tree-sitter did not start')
  local parser = vim.treesitter.get_parser(0, 'xph')
  parser:parse(true)
  local function language_at(row, col)
    return parser:language_for_range({ row, col, row, col + 1 }):lang()
  end
  assert(language_at(1, 25) == 'typescript', 'frontmatter is not TypeScript')
  assert(language_at(4, 1) == 'php_only', 'PHP variable is not injected')
  assert(language_at(5, 1) == 'php_only', 'PHP return is not injected')
  assert(language_at(7, 1) == 'xph', 'PHP leaked into markup')
  assert(language_at(7, 8) == 'typescript', 'expression is not TypeScript')
  assert(language_at(9, 1) == 'typescript', 'browser script is not TypeScript')
  assert(language_at(12, 5) == 'css', 'style is not CSS')
  assert(vim.treesitter.query.get('astro', 'injections') == astro_query, 'Astro injection query was changed')
  local php_variables, php_keywords = false, false
  parser:for_each_tree(function(tree, lang_tree)
    if lang_tree:lang() == 'php_only' then
      local query = vim.treesitter.query.get('php_only', 'highlights')
      for id in query:iter_captures(tree:root(), 0) do
        php_variables = php_variables or query.captures[id] == 'variable'
        php_keywords = php_keywords or query.captures[id] == 'keyword.return'
      end
    end
  end)
  assert(php_variables and php_keywords, 'missing PHP semantic captures')

  for _, opening in ipairs({
    '<script server lang="php">',
    "<script lang='php' server>",
    '<script lang=php server>',
    '<script\n lang="php"\n server\n>',
  }) do
    local lines = vim.split(opening .. '\nreturn [];\n</script>\n<p>hi</p>', '\n')
    vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
    parser:parse(true)
    local row = #lines - 3
    assert(language_at(row, 1) == 'php_only', 'PHP injection failed for ' .. opening)
    -- No overlapping TypeScript parse may include the PHP body.
    parser:for_each_tree(function(tree, lang_tree)
      if lang_tree:lang() == 'typescript' then
        assert(not tree:root():contains(row, 1, row, 2), 'PHP also injected as TypeScript')
      end
    end)
    assert(language_at(#lines - 1, 1) == 'xph', 'PHP injection did not close')
  end
  for _, opening in ipairs({ '<script>', '<script lang="ts">', '<script server lang="ts">', '<script lang="php">', '<script data-server lang="php">' }) do
    vim.api.nvim_buf_set_lines(0, 0, -1, false, { opening, 'const value = 1;', '</script>' })
    parser:parse(true)
    assert(language_at(1, 1) == 'typescript', 'incorrect PHP injection for ' .. opening)
  end
  print('Tree-sitter Astro reuse, PHP captures, injection boundaries, and TypeScript/CSS injections passed.')
end
local ok, err = xpcall(test, debug.traceback)
if not ok then
  io.stderr:write(err .. '\n')
  vim.cmd('cquit 1')
else
  vim.cmd('qa!')
end
