local function test()
  vim.opt.runtimepath:prepend(vim.env.XPH_NVIM_RUNTIME)
  vim.cmd('filetype plugin on')
  local backend_cmd = { vim.env.XPH_NVIM_NODE, vim.env.XPH_NVIM_PHP_FIXTURE }
  vim.lsp.config('intelephense', {
    cmd = backend_cmd,
    filetypes = { 'php' },
    settings = { intelephense = { format = { enable = true } } },
  })
  local detected = require('xph.php').detect(vim.env.XPH_NVIM_PROJECT)
  assert(detected.command == vim.env.XPH_NVIM_NODE, 'did not resolve the editor command')
  assert(vim.deep_equal(detected.args, { vim.env.XPH_NVIM_PHP_FIXTURE }), 'lost command arguments')
  assert(detected.settings.intelephense.format.enable, 'lost PHP settings')
  require('xph').setup({ cmd = { vim.env.XPH_NVIM_NODE, vim.env.XPH_NVIM_CLI, 'lsp' } })
  vim.cmd.edit(vim.env.XPH_NVIM_PROJECT .. '/Page.xph')
  assert(vim.wait(10000, function()
    local clients = vim.lsp.get_clients({ bufnr = 0, name = 'xph' })
    return clients[1] and clients[1].initialized
  end, 20), 'xph did not initialize')
  local client = vim.lsp.get_clients({ bufnr = 0, name = 'xph' })[1]
  assert(client.config.init_options.phpLanguageServerFallback, 'did not forward PHP discovery')
  local response = client:request_sync('textDocument/formatting', {
    textDocument = { uri = vim.uri_from_bufnr(0) },
    options = { tabSize = 2, insertSpaces = true },
  }, 10000, 0)
  assert(response and response.result and response.result[1], 'missing formatting edits')
  assert(response.result[1].newText:find('$local = 1;', 1, true), 'PHP formatter was not used')
  assert(vim.wait(10000, function()
    for _, diagnostic in ipairs(vim.diagnostic.get(0)) do
      if diagnostic.message == 'Mapped PHP diagnostic' then return true end
    end
    return false
  end, 20), 'PHP diagnostics were not mapped')
  client:stop(true)
end
local ok, err = xpcall(test, debug.traceback)
if not ok then
  io.stderr:write(err .. '\n')
  vim.cmd('cquit 1')
else
  vim.cmd('qa!')
end
