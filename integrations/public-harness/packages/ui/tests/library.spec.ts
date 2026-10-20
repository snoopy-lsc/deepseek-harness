import { describe, expect, it } from 'vitest'
import { browseEntries, filterLibraries, sourceFileError } from '../src/client/library-model.ts'
import { libraryCopy } from '../src/client/library-copy.ts'

const files = [
  { path: 'index.md', bytes: 10 }, { path: 'raw/Launch Plan.pdf', bytes: 100 },
  { path: 'raw/notes/phase-1.md', bytes: 20 }, { path: 'raw/notes/phase-2.txt', bytes: 30 },
  { path: 'wiki/Launch.md', bytes: 50 },
]

describe('library browsing', () => {
  it('filters_real_titles_and_descriptions_without_losing_the_source_items', () => {
    const own = [{ id: '1', title: 'Launch', description: 'Deployment runbook' }, { id: '2', title: 'Personnel', description: 'Hiring' }]
    expect(filterLibraries(own, ' DEPLOYMENT ')).toEqual([own[0]])
    expect(filterLibraries(own, 'ｌａｕｎｃｈ')).toEqual([own[0]])
    expect(filterLibraries(own, 'missing')).toEqual([])
    expect(filterLibraries([{ title: 'Shared' }], '')).toEqual([{ title: 'Shared' }])
  })
  it('shows_real_directories_and_immediate_files_with_aggregate_sizes', () => {
    expect(browseEntries(files, '', '')).toEqual([
      { kind: 'directory', name: 'raw', path: 'raw', bytes: 150, count: 3 },
      { kind: 'directory', name: 'wiki', path: 'wiki', bytes: 50, count: 1 },
      { kind: 'file', name: 'index.md', path: 'index.md', bytes: 10 },
    ])
    expect(browseEntries(files, 'raw', '')).toEqual([
      { kind: 'directory', name: 'notes', path: 'raw/notes', bytes: 50, count: 2 },
      { kind: 'file', name: 'Launch Plan.pdf', path: 'raw/Launch Plan.pdf', bytes: 100 },
    ])
  })
  it('searches_file_paths_within_the_current_directory_and_returns_openable_files', () => {
    expect(browseEntries(files, '', 'LAUNCH').map(entry => entry.path)).toEqual(['raw/Launch Plan.pdf', 'wiki/Launch.md'])
    expect(browseEntries(files, 'raw', 'phase').map(entry => entry.path)).toEqual(['raw/notes/phase-1.md', 'raw/notes/phase-2.txt'])
    expect(browseEntries(files, 'wiki', 'notes')).toEqual([])
    expect(browseEntries([...files, { path: 'raw-other/notes.md', bytes: 1 }], 'raw', 'notes').length).toBe(2)
  })
  it('validates_the_supported_upload_formats_and_25_mib_limit', () => {
    expect(sourceFileError({ name: 'Runbook.PDF', size: 25 * 1024 * 1024 })).toBeUndefined()
    expect(sourceFileError({ name: 'runbook.docx', size: 25 * 1024 * 1024 + 1 })).toBe('kb_err_too_large')
    expect(sourceFileError({ name: 'image.exe', size: 12 })).toBe('kb_err_source_name')
  })
  it('has_complete_nonempty_localized_copy', () => {
    expect(Object.keys(libraryCopy.en).sort()).toEqual(Object.keys(libraryCopy.zh).sort())
    for (const copy of Object.values(libraryCopy)) for (const text of Object.values(copy)) expect(text.length).toBeGreaterThan(0)
  })
})
