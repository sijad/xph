local M = {}

local function backend(config)
  if not config or type(config.cmd) ~= 'table' or type(config.cmd[1]) ~= 'string' then
    return nil
  end
  -- Resolve Mason's PATH inside Neovim, before handing the command to Node.
  local command = vim.fn.exepath(config.cmd[1])
  if command == '' then
    return nil
  end
  return {
    command = command,
    args = vim.list_slice(config.cmd, 2),
    initializationOptions = vim.deepcopy(config.init_options),
    settings = vim.deepcopy(config.settings),
  }
end

function M.detect(root)
  for _, client in ipairs(vim.lsp.get_clients()) do
    local config = client.config
    local client_root = config.root_dir
    if vim.tbl_contains(config.filetypes or {}, 'php')
      and type(client_root) == 'string'
      and (root == client_root or vim.startswith(root, client_root .. '/')) then
      local found = backend(config)
      if found then
        return found
      end
    end
  end
  -- Looking up these configs also loads lsp/*.lua from nvim-lspconfig.
  for _, name in ipairs({ 'intelephense', 'phpactor' }) do
    local found = backend(vim.lsp.config[name])
    if found then
      return found
    end
  end
  local command = vim.fn.exepath('intelephense')
  if command ~= '' then
    return { command = command, args = { '--stdio' } }
  end
end

return M
