vim.opt.runtimepath:prepend(vim.env.XPH_NVIM_RUNTIME)
vim.cmd('runtime plugin/xph.lua')
vim.cmd('packadd matchit')
vim.cmd('filetype plugin on')
vim.cmd('syntax on')
vim.cmd('enew')
vim.bo.filetype = 'xph'

local cases = {
  { { '<Card>', '<Card>inner</Card>', '</Card>' }, { 1, 0 } },
  { { '<Card>', '<card>inner</card>', '</Card>' }, { 1, 1 } },
  { { '<Card>', '<Card>inner</Card>', '</Card>' }, { 3, 1 } },
  { { '<Card>', '<Card />', '</Card>' }, { 1, 1 } },
  { { '<UI.Card>', 'content', '</UI.Card>' }, { 1, 1 } },
  { { '<>', '<div>content</div>', '</>' }, { 1, 0 } },
  { { '{ value: [1, 2] }' }, { 1, 0 } },
  { { '<!-- comment -->' }, { 1, 0 } },
  { { 'do {', '  work()', '} while (ready)' }, { 1, 0 } },
}
local function positions(filetype)
  vim.bo.filetype = filetype
  local result = {}
  for _, case in ipairs(cases) do
    vim.api.nvim_buf_set_lines(0, 0, -1, false, case[1])
    vim.api.nvim_win_set_cursor(0, case[2])
    vim.cmd('normal %')
    table.insert(result, vim.api.nvim_win_get_cursor(0))
  end
  return result
end
local xph_words = vim.b.match_words
local xph_pairs = vim.bo.matchpairs
local xph_positions = positions('xph')
local astro_positions = positions('astro')
assert(vim.b.match_words == xph_words, 'XPH match words differ from Astro')
assert(vim.bo.matchpairs == xph_pairs, 'XPH bracket pairs differ from Astro')
assert(vim.deep_equal(xph_positions, astro_positions), 'XPH percent matching differs from Astro')
assert(vim.deep_equal(xph_positions[2], { 3, 1 }), 'component tag matching failed')
vim.bo.filetype = 'text'
assert(vim.b.match_words == nil, 'matching settings leaked into another filetype')
print('Astro matching parity passed')
