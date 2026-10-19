if vim.g.loaded_xph then
  return
end
vim.g.loaded_xph = true
vim.filetype.add({ extension = { xph = 'xph' } })
