local config = require('overleaf.config')
local project = require('overleaf.project')

local M = {}

local function project_docs()
  local docs = {}
  for _, entry in ipairs(project._project_tree) do
    if entry.type == 'doc' then docs[#docs + 1] = entry end
  end
  return docs
end

local function search_content(results, doc_entry, content, query)
  if not query or query == '' then return end

  local lines = vim.split(content, '\n', { plain = true })
  for lnum, line in ipairs(lines) do
    local col = line:find(query, 1, true)
    if col then
      table.insert(results, {
        doc_id = doc_entry.id,
        path = doc_entry.path,
        lnum = lnum,
        col = col,
        text = vim.trim(line),
      })
    end
  end
end

-- Search reads the coordinator's current views: dirty native buffers when
-- open and saved snapshots otherwise. It never changes document subscriptions.
local function results_for(context, query, pattern)
  local results, unavailable = {}, 0
  if not context or context.closing or require('overleaf.sync')._workspace ~= context then return results, 0 end
  for _, entry in ipairs(project_docs()) do
    local doc = context.documents[entry.id]
    local content = doc and doc.content
    if content then
      if pattern then
        for lnum, line in ipairs(vim.split(content, '\n', { plain = true })) do
          local col = line:find(query)
          if col then
            results[#results + 1] = {
              doc_id = entry.id,
              path = entry.path,
              lnum = lnum,
              col = col,
              text = vim.trim(line),
            }
          end
        end
      else
        search_content(results, entry, content, query)
      end
    else
      unavailable = unavailable + 1
    end
  end
  return results, unavailable
end

--- Search downloaded project views for a Lua pattern, including unsaved edits.
function M.grep(pattern, _state)
  if not pattern or pattern == '' then return end
  local context = require('overleaf.sync')._workspace
  local ok, results, unavailable = pcall(results_for, context, pattern, true)
  if not ok then
    config.log('warn', 'Invalid search pattern: %s', results)
    return
  end
  if unavailable > 0 then config.log('info', 'Skipped %d documents that are not downloaded yet', unavailable) end
  if #results == 0 then
    config.log('info', 'No matches found for: %s', pattern)
    return
  end
  require('overleaf.picker').locations({ title = 'Overleaf Search: ' .. pattern }, results, function(location)
    if require('overleaf.sync')._workspace == context and not context.closing then
      require('overleaf').open_location(location)
    end
  end)
end

function M.live(state)
  local docs = project_docs()
  if #docs == 0 then
    config.log('info', 'No documents to search')
    return
  end

  local context = require('overleaf.sync')._workspace

  local picker_mod = require('overleaf.picker')
  local picker

  local finder = function(_, ctx)
    local query = ctx.filter.search or ''
    if query == '' then return {} end

    local items = {}

    for idx, location in ipairs(results_for(context, query, false)) do
      items[#items + 1] = {
        text = ('%s:%d:%d %s'):format(location.path, location.lnum, location.col, location.text),
        idx = idx,
        item = location,
        path = location.path,
        lnum = location.lnum,
        col = location.col,
        line = location.text,
      }
    end

    return items
  end

  picker = picker_mod.live_locations(
    {
      title = 'Overleaf Search',
    },
    finder,
    function(location)
      if require('overleaf.sync')._workspace == context and not context.closing then
        require('overleaf').open_location(location)
      end
    end
  )

  if picker then return end

  vim.ui.input({ prompt = 'Search pattern: ' }, function(pattern)
    if pattern and pattern ~= '' and require('overleaf.sync')._workspace == context then M.grep(pattern, state) end
  end)
end

return M
