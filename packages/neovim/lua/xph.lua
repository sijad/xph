local M = {}

---Enable the xph language server. Requires Neovim 0.11+ and xph on PATH.
---@param opts? vim.lsp.ClientConfig|{treesitter: boolean}
function M.setup(opts)
  if vim.fn.has('nvim-0.11') == 0 then
    error('xph requires Neovim 0.11 or newer')
  end
  opts = opts or {}
  vim.filetype.add({ extension = { xph = 'xph' } })
  local lsp_opts = vim.deepcopy(opts)
  lsp_opts.treesitter = nil
  local group = vim.api.nvim_create_augroup('xph_lsp', { clear = true })
  local function attach(bufnr)
    if vim.bo[bufnr].filetype ~= 'xph' or vim.api.nvim_buf_get_name(bufnr) == '' then
      return
    end
    if opts.treesitter then
      require('xph.treesitter').start(bufnr)
    end
    local root = vim.fs.root(bufnr, 'xph.config.ts')
      or vim.fs.root(bufnr, { 'package.json', '.git' })
      or vim.fs.dirname(vim.api.nvim_buf_get_name(bufnr))
    local config = vim.tbl_deep_extend('force', {
      name = 'xph',
      cmd = { 'xph', 'lsp' },
      root_dir = root,
      -- The CLI loads xph.config.ts relative to its working directory.
      cmd_cwd = root,
    }, lsp_opts)
    vim.lsp.start(config, { bufnr = bufnr })
  end
  vim.api.nvim_create_autocmd('FileType', {
    group = group,
    pattern = 'xph',
    callback = function(event)
      attach(event.buf)
    end,
  })
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(bufnr) then
      attach(bufnr)
    end
  end
end

return M
