local function test()
  vim.opt.runtimepath:prepend(vim.env.XPH_NVIM_RUNTIME)
  vim.cmd('runtime plugin/xph.lua')
  vim.cmd('filetype on')
  vim.cmd('syntax on')
  vim.cmd.edit(vim.fn.fnameescape(vim.env.XPH_NVIM_PROJECT .. '/Page.xph'))
  assert(vim.bo.filetype == 'xph', 'filetype detection failed')
  assert(vim.b.current_syntax == 'xph', 'syntax was not loaded')
  assert(vim.g.astro_typescript == nil, 'syntax changed global Astro options')

  local function groups(line, col)
    return vim.tbl_map(function(id)
      return vim.fn.synIDattr(id, 'name')
    end, vim.fn.synstack(line, col))
  end
  local function has_prefix(line, col, prefix)
    for _, name in ipairs(groups(line, col)) do
      if name:sub(1, #prefix) == prefix then
        return true
      end
    end
    error(('expected %s at %d:%d, got %s'):format(prefix, line, col, vim.inspect(groups(line, col))))
  end
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  has_prefix(2, 8, 'typescript')
  has_prefix(5, 1, 'php')
  has_prefix(6, 13, 'php') -- A string containing </script> stays in PHP.
  has_prefix(7, 1, 'php')
  has_prefix(9, 2, 'html')
  assert(not vim.tbl_contains(groups(9, 2), 'xphPHP'), 'PHP leaked into markup')
  has_prefix(11, 1, 'typescript')
  has_prefix(14, 1, 'css')

  for _, opening in ipairs({
    '<script is:server>',
    '<script id="setup" is:server>',
    '<script is:server id="setup">',
    '<script\n is:server\n>',
  }) do
    local snippet = vim.split(opening .. '\nreturn [];\n</script>\n<p>Hi</p>', '\n')
    vim.api.nvim_buf_set_lines(0, 0, -1, false, snippet)
    vim.cmd('syntax sync fromstart')
    vim.cmd('redraw!')
    has_prefix(#snippet - 2, 1, 'php')
    has_prefix(#snippet, 2, 'html')
    assert(not vim.tbl_contains(groups(#snippet, 2), 'xphPHP'), 'PHP leaked after closing tag')
  end
  local inline = '<script is:server>return [];</script><p>Hi</p>'
  vim.api.nvim_buf_set_lines(0, 0, -1, false, { inline })
  vim.cmd('syntax sync fromstart')
  vim.cmd('redraw!')
  has_prefix(1, assert(inline:find('return', 1, true)), 'php')
  local tag = assert(inline:find('<p>', 1, true)) + 1
  has_prefix(1, tag, 'html')
  assert(not vim.tbl_contains(groups(1, tag), 'xphPHP'), 'PHP leaked in a single-line block')
  vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)

  require('xph').setup({ cmd = { vim.env.XPH_NVIM_NODE, vim.env.XPH_NVIM_CLI, 'lsp' } })
  assert(vim.wait(10000, function()
    local clients = vim.lsp.get_clients({ bufnr = 0, name = 'xph' })
    return #clients == 1 and clients[1].initialized
  end, 20), 'LSP did not attach')
  local client = vim.lsp.get_clients({ bufnr = 0, name = 'xph' })[1]
  assert(vim.uv.fs_realpath(client.config.cmd_cwd) == vim.uv.fs_realpath(vim.env.XPH_NVIM_PROJECT), 'incorrect project working directory')
  assert(client.offset_encoding == 'utf-16', 'incorrect position encoding')
  local function query(method, line, character)
    local response = client:request_sync(method, {
      textDocument = { uri = vim.uri_from_bufnr(0) },
      position = { line = line, character = character },
    }, 10000, 0)
    assert(response and not response.err, 'LSP query failed: ' .. vim.inspect(response))
    return response.result
  end
  local property = assert(lines[9]:find('title', 1, true)) - 1
  local definitions = query('textDocument/definition', 8, property + 2)
  assert(definitions[1].uri == vim.uri_from_bufnr(0), 'definition has incorrect URI')
  assert(definitions[1].range.start.line == 1, 'definition has incorrect line')
  assert(definitions[1].range.start.character == 25, 'definition has incorrect column')
  local hover = query('textDocument/hover', 8, property + 2)
  assert(hover.contents.value:find('string', 1, true), 'missing contract hover')
  local completions = query('textDocument/completion', 8, property)
  assert(vim.iter(completions.items):any(function(item) return item.label == 'title' end), 'missing completion')
  assert(vim.wait(10000, function()
    for _, diagnostic in ipairs(vim.diagnostic.get(0)) do
      if diagnostic.message:find('/missing/xph-test-php', 1, true) then
        return true
      end
    end
    return false
  end, 20), 'project PHP configuration or diagnostics were not loaded')
  local native = query('textDocument/definition', 15, 8)
  assert(native and native[1], 'missing native attribute definition')
  assert(native[1].uri:find('/xph%.d%.ts$'), 'incorrect native attribute target')
  assert(vim.lsp.util.show_document(native[1], client.offset_encoding, { focus = true }), 'could not open native attribute definition')
  assert(vim.api.nvim_get_current_line():find('charset?: string | null', 1, true), 'did not navigate to charset declaration')
  client:stop(true)
  print('Neovim filetype, highlighting, LSP attachment, definitions, hover, completion and diagnostics passed.')
end
local ok, err = xpcall(test, debug.traceback)
if not ok then
  io.stderr:write(err .. '\n')
  vim.cmd('cquit 1')
else
  vim.cmd('qa!')
end
