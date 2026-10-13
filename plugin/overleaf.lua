-- Main :Overleaf command with subcommands.
local function rest(args, start)
  if #args < start then return nil end
  local value = table.concat(vim.list_slice(args, start), ' ')
  return value ~= '' and value or nil
end

local commands = {
  projects = function() require('overleaf').projects() end,
  status = function() require('overleaf').status() end,
  disconnect = function() require('overleaf').disconnect() end,
  conflicts = function() require('overleaf').conflicts() end,
  resolve = function(args) require('overleaf').resolve(args[1]) end,
  recover = function(args) require('overleaf').recover(args[1]) end,
  migrate = function(args) require('overleaf').migrate(rest(args, 1)) end,

  explorer = function(args)
    if args[1] == 'native' then
      require('overleaf').open_native_tree()
    else
      require('overleaf').open_explorer()
    end
  end,

  files = function(args) require('overleaf').files(rest(args, 1)) end,
  preview = function() require('overleaf').preview_file() end,

  new = function(args) require('overleaf').create_doc(rest(args, 1)) end,
  mkdir = function(args) require('overleaf').create_folder(rest(args, 1)) end,
  delete = function() require('overleaf').delete_entity() end,
  rename = function() require('overleaf').rename_entity() end,
  upload = function(args) require('overleaf').upload_file(rest(args, 1)) end,

  search = function(args) require('overleaf').search(rest(args, 1)) end,

  comment = function(args)
    local action = args[1] or 'add'
    if action == 'add' then
      require('overleaf').create_comment_from_selection()
    elseif action == 'show' then
      require('overleaf').show_comment()
    elseif action == 'reply' then
      require('overleaf').reply_comment()
    elseif action == 'resolve' then
      require('overleaf').resolve_comment()
    else
      vim.notify('Unknown Overleaf comment action: ' .. action, vim.log.levels.ERROR)
    end
  end,

  comments = function(args)
    if args[1] == 'drafts' then
      require('overleaf').comment_drafts()
    elseif args[1] == 'refresh' then
      require('overleaf').refresh_comments()
    else
      require('overleaf').list_comments()
    end
  end,

  compile = function(args)
    local action = args[1]
    if action == 'watch' then
      require('overleaf').compile_watch()
    elseif action == 'stop' then
      require('overleaf').stop_compile_watch()
    elseif action == 'local' then
      require('overleaf').compile_local()
    else
      require('overleaf').compile()
    end
  end,

  sync = function(args)
    local action = args[1]
    if action == 'import' then
      require('overleaf').sync_import()
    elseif action == 'export' then
      require('overleaf').sync_export()
    else
      require('overleaf').sync_all()
    end
  end,

  history = function() require('overleaf').history() end,
}

local completions = vim.tbl_keys(commands)
table.sort(completions)

local subcommand_completions = {
  comment = { 'add', 'show', 'reply', 'resolve' },
  comments = { 'refresh', 'drafts' },
  compile = { 'local', 'watch', 'stop' },
  explorer = { 'native' },
  sync = { 'import', 'export' },
  resolve = { 'history', 'disk-history', 'codediff' },
  recover = { 'locks' },
}

vim.api.nvim_create_user_command('Overleaf', function(opts)
  local args = opts.fargs or {}
  local sub = args[1]

  if not sub or sub == '' then
    vim.notify('Usage: :Overleaf projects', vim.log.levels.INFO)
    return
  end

  local command = commands[sub]
  if command then
    command(vim.list_slice(args, 2))
    return
  end

  vim.notify(
    'Unknown Overleaf subcommand: ' .. sub .. '\nAvailable: ' .. table.concat(completions, ', '),
    vim.log.levels.ERROR
  )
end, {
  nargs = '*',
  range = true,
  desc = 'Overleaf commands',
  complete = function(arglead, line, _)
    local parts = vim.split(line, '%s+', { trimempty = true })

    if #parts <= 2 and not (line:match('%s$') and #parts >= 2) then
      local matches = {}
      for _, name in ipairs(completions) do
        if name:find(arglead or '', 1, true) == 1 then table.insert(matches, name) end
      end
      return matches
    end

    local sub = parts[2]
    local candidates = subcommand_completions[sub]
    if not candidates then return {} end

    local matches = {}
    for _, name in ipairs(candidates) do
      if name:find(arglead or '', 1, true) == 1 then table.insert(matches, name) end
    end
    return matches
  end,
})
