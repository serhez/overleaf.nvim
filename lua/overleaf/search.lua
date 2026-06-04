local bridge = require('overleaf.bridge')
local config = require('overleaf.config')
local project = require('overleaf.project')

local M = {}

M._live_cache = {
  project_id = nil,
  contents = {},
  fetching = {},
  loading = false,
}

local function project_docs()
  local docs = {}
  for _, entry in ipairs(project._project_tree) do
    if entry.type == 'doc' then table.insert(docs, entry) end
  end
  return docs
end

local function cache_for(state)
  local project_id = state and state.project_id or nil
  if M._live_cache.project_id ~= project_id then
    M._live_cache = {
      project_id = project_id,
      contents = {},
      fetching = {},
      loading = false,
    }
  end

  if state and state.documents then
    for _, doc_entry in ipairs(project_docs()) do
      local open_doc = state.documents[doc_entry.id]
      if open_doc and open_doc.content then
        M._live_cache.contents[doc_entry.id] = {
          entry = doc_entry,
          content = open_doc.content,
        }
      end
    end
  end

  return M._live_cache
end

local function ensure_live_cache(state, on_update)
  local cache = cache_for(state)
  if cache.loading then return cache end

  local queue = {}
  for _, doc_entry in ipairs(project_docs()) do
    if not cache.contents[doc_entry.id] and not cache.fetching[doc_entry.id] then queue[#queue + 1] = doc_entry end
  end

  if #queue == 0 then return cache end

  cache.loading = true

  local function process_next()
    local doc_entry = table.remove(queue, 1)
    if not doc_entry then
      cache.loading = false
      vim.schedule(on_update)
      return
    end

    cache.fetching[doc_entry.id] = true
    bridge.request('joinDoc', { docId = doc_entry.id }, function(err, result)
      if not err and result and result.lines then
        cache.contents[doc_entry.id] = {
          entry = doc_entry,
          content = table.concat(result.lines, '\n'),
        }
      end

      local function done()
        cache.fetching[doc_entry.id] = nil
        vim.schedule(on_update)
        process_next()
      end

      if not err and result then
        bridge.request('leaveDoc', { docId = doc_entry.id }, done)
      else
        done()
      end
    end)
  end

  process_next()
  return cache
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

local function cached_results(state, query)
  local results = {}
  local cache = cache_for(state)
  if not query or query == '' then return results end

  for _, doc_entry in ipairs(project_docs()) do
    local cached = cache.contents[doc_entry.id]
    if cached and cached.content then search_content(results, cached.entry or doc_entry, cached.content, query) end
  end

  return results
end

--- Search all project documents for a Lua pattern.
function M.grep(pattern, state)
  if not pattern or pattern == '' then return end

  local docs = {}
  for _, entry in ipairs(project._project_tree) do
    if entry.type == 'doc' then table.insert(docs, entry) end
  end

  if #docs == 0 then
    config.log('info', 'No documents to search')
    return
  end

  local results = {}
  local total = #docs
  local processed = 0

  config.log('info', 'Searching %d documents...', total)

  local function finish()
    vim.schedule(function()
      if #results == 0 then
        config.log('info', 'No matches found for: %s', pattern)
        return
      end

      require('overleaf.picker').locations({
        title = 'Overleaf Search: ' .. pattern,
      }, results, function(location) require('overleaf').open_location(location) end)
      config.log('info', 'Found %d matches in %d documents', #results, total)
    end)
  end

  local function search_content(doc_entry, content)
    local lines = vim.split(content, '\n', { plain = true })
    for lnum, line in ipairs(lines) do
      local col = line:find(pattern)
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

  local function process_next(idx)
    if idx > total then
      finish()
      return
    end

    local doc_entry = docs[idx]
    processed = processed + 1

    -- Check if document is already open (has content in memory)
    local open_doc = state and state.documents[doc_entry.id]
    if open_doc and open_doc.content then
      search_content(doc_entry, open_doc.content)
      process_next(idx + 1)
      return
    end

    -- Join doc temporarily to search
    bridge.request('joinDoc', { docId = doc_entry.id }, function(err, result)
      if not err and result and result.lines then
        local content = table.concat(result.lines, '\n')
        search_content(doc_entry, content)
      end

      -- Leave the doc after searching
      bridge.request('leaveDoc', { docId = doc_entry.id }, function() process_next(idx + 1) end)
    end)
  end

  process_next(1)
end

function M.live(state)
  local docs = project_docs()
  if #docs == 0 then
    config.log('info', 'No documents to search')
    return
  end

  M._live_cache = {
    project_id = state and state.project_id or nil,
    contents = {},
    fetching = {},
    loading = false,
  }

  local picker_mod = require('overleaf.picker')
  local picker

  local function refresh()
    if picker and not picker.closed then picker:find({ refresh = true }) end
  end

  local finder = function(_, ctx)
    local query = ctx.filter.search or ''
    if query == '' then return {} end

    ensure_live_cache(state, refresh)
    local items = {}

    for idx, location in ipairs(cached_results(state, query)) do
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

  picker = picker_mod.live_locations({
    title = 'Overleaf Search',
  }, finder, function(location) require('overleaf').open_location(location) end)

  if picker then
    return
  end

  vim.ui.input({ prompt = 'Search pattern: ' }, function(pattern)
    if pattern and pattern ~= '' then M.grep(pattern, state) end
  end)
end

return M
