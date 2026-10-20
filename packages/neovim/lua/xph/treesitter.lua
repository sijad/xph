local M = {}
local registered = false

local function attributes(tag, source)
  local attrs = {}
  for child in tag:iter_children() do
    if child:type() == 'attribute' then
      local name = child:named_child(0)
      local value = child:named_child(1)
      if value and value:type() == 'quoted_attribute_value' then
        value = value:named_child(0)
      end
      if name then
        attrs[vim.treesitter.get_node_text(name, source)] = value
          and vim.treesitter.get_node_text(value, source) or true
      end
    end
  end
  return attrs
end

local function register()
  if registered then
    return
  end
  vim.treesitter.query.add_directive('xph-script-language!', function(match, _, source, predicate, metadata)
    local nodes = match[predicate[2]]
    local tag = nodes and nodes[1]
    if not tag then
      return
    end
    local attrs = attributes(tag, source)
    metadata['injection.language'] = attrs.server and attrs.lang == 'php' and 'php_only' or 'typescript'
  end, { force = true })
  registered = true
end

---Start Astro-based Tree-sitter highlighting with xph-specific injections.
---Returns false when parsers or highlight queries are unavailable.
function M.start(bufnr)
  for _, lang in ipairs({ 'astro', 'php_only', 'typescript', 'css' }) do
    local ok, loaded = pcall(vim.treesitter.language.add, lang)
    if not ok or not loaded then
      return false
    end
    local query_ok, query = pcall(vim.treesitter.query.get, lang, 'highlights')
    if not query_ok or not query then
      return false
    end
  end
  local path = vim.api.nvim_get_runtime_file('parser/astro.*', false)[1]
  if not path then
    return false
  end
  -- Reuse the Astro binary with a separate query namespace. Never override
  -- Astro's unconditional TypeScript script injection for ordinary .astro files.
  local ok, loaded = pcall(vim.treesitter.language.add, 'xph', { path = path, symbol_name = 'astro' })
  if not ok or not loaded then
    return false
  end
  register()
  local started = pcall(vim.treesitter.start, bufnr, 'xph')
  if not started then
    vim.treesitter.stop(bufnr)
    vim.bo[bufnr].syntax = 'xph'
  end
  return started
end

return M
