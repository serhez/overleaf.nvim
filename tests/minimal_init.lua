-- Keep concurrent test processes out of each other's swap/undo files and the
-- user's persistent editor state. Individual tests may override these paths.
local artifacts = vim.fn.tempname()
vim.fn.mkdir(artifacts, 'p', 448)
vim.opt.directory = artifacts .. '//'
vim.opt.backupdir = artifacts .. '//'
vim.opt.undodir = artifacts .. '//'
vim.opt.shadafile = 'NONE'

-- Minimal init for running tests with Plenary
local plenary_dir = vim.fn.getcwd() .. '/.tests/plenary.nvim'
vim.opt.rtp:append('.')
vim.opt.rtp:append(plenary_dir)
vim.cmd('runtime plugin/plenary.vim')
