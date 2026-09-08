use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use rayon::prelude::*;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::embed::Embedder;
use crate::error::CodeGraphError;
use crate::parse::{detect_language, parse_file, ParsedFile};
use crate::store::sqlite::SqliteStore;
use crate::types::{FileId, FileNode, SymbolId, SymbolNode};

/// Summary statistics returned by `bulk_index`.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct IndexStats {
    pub files: usize,
    pub symbols: usize,
    pub edges: usize,
    pub skipped_unchanged: usize,
    pub total_files: usize,
    pub total_symbols: usize,
}

/// Index every supported source file under `root` into `store`.
///
/// Files whose `content_hash` already matches what's in the database are
/// skipped. Parsing fans out across rayon's thread pool; persistence runs on
/// the caller's thread because `SqliteStore` is single-writer.
pub fn bulk_index(store: &mut SqliteStore, root: &Path) -> Result<IndexStats, CodeGraphError> {
    let root = std::fs::canonicalize(root)?;
    bind_workspace(store, &root)?;
    let paths = collect_source_files(&root)?;
    let existing_hashes = load_existing_hashes(store)?;
    // Propagate read/parse failures: a partial scan must never delete good data.
    let parsed: Vec<Option<ParsedFile>> = paths
        .par_iter()
        .map(|p| {
            let source = std::fs::read(p)?;
            let hash = xxhash_rust::xxh3::xxh3_64(&source);
            if existing_hashes.get(&p.to_string_lossy().to_string()) == Some(&hash) {
                Ok(None)
            } else {
                parse_file(p).map(Some)
            }
        })
        .collect::<Result<_, CodeGraphError>>()?;
    let mut stats = IndexStats::default();
    let present: HashSet<_> = paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    if parsed.iter().all(Option::is_none) && existing_hashes.keys().all(|p| present.contains(p)) {
        return Ok(IndexStats {
            skipped_unchanged: paths.len(),
            total_files: paths.len(),
            total_symbols: store
                .conn
                .query_row("SELECT COUNT(*) FROM symbols", [], |row| row.get(0))?,
            ..Default::default()
        });
    }
    let tx = store.conn.transaction()?;
    for old in existing_hashes.keys().filter(|p| !present.contains(*p)) {
        tx.execute("DELETE FROM files WHERE path = ?1", [old])?;
    }
    for parsed in parsed {
        if let Some(pf) = parsed {
            stats.files += 1;
            stats.symbols += pf.symbols.len();
            replace_file_tx(&tx, pf)?;
        } else {
            stats.skipped_unchanged += 1;
        }
    }
    stats.edges = resolve_edges_tx(&tx)?;
    stats.total_files = paths.len();
    stats.total_symbols = tx.query_row("SELECT COUNT(*) FROM symbols", [], |row| row.get(0))?;
    tx.commit()?;
    Ok(stats)
}

/// A database belongs to exactly one canonical workspace. Legacy databases are
/// adopted only if every stored file belongs to that workspace.
fn bind_workspace(store: &SqliteStore, root: &Path) -> Result<(), CodeGraphError> {
    use rusqlite::OptionalExtension;
    let owner: Option<String> = store
        .conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'workspace'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let root = root.to_string_lossy().to_string();
    if owner.as_ref().is_some_and(|p| p != &root)
        || load_existing_hashes(store)?
            .keys()
            .any(|p| !Path::new(p).starts_with(&root))
    {
        return Err(CodeGraphError::Parse(
            "database belongs to another workspace; use a separate database".into(),
        ));
    }
    store.conn.execute(
        "INSERT OR IGNORE INTO metadata(key,value) VALUES ('workspace',?1)",
        [&root],
    )?;
    Ok(())
}

/// Validate even removed paths before using them for incremental deletion.
pub(crate) fn checked_index_path(
    store: &SqliteStore,
    path: &Path,
) -> Result<PathBuf, CodeGraphError> {
    use rusqlite::OptionalExtension;
    let owner: Option<String> = store
        .conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'workspace'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let root = match owner {
        Some(p) => PathBuf::from(p),
        None => {
            let parent = std::fs::canonicalize(
                path.parent()
                    .ok_or_else(|| CodeGraphError::Parse("file has no parent".into()))?,
            )?;
            bind_workspace(store, &parent)?;
            parent
        }
    };
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let alias = candidate
        .ancestors()
        .find(|p| std::fs::canonicalize(p).is_ok_and(|p| p == root));
    let relative = candidate
        .strip_prefix(&root)
        .or_else(|_| candidate.strip_prefix(alias.as_ref().unwrap_or(&root.as_path())))
        .map_err(|_| CodeGraphError::Parse("file outside workspace".into()))?;
    let mut checked = root.clone();
    for part in relative.components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err(CodeGraphError::Parse("invalid workspace path".into()));
        }
        checked.push(part);
        match std::fs::symlink_metadata(&checked) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(CodeGraphError::Parse("symlink indexing is disabled".into()))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(checked)
}

/// Index a change or remove a deleted file, then resolve references again.
pub fn index_one_file(
    store: &mut SqliteStore,
    path: &Path,
) -> Result<Option<FileId>, CodeGraphError> {
    let path = checked_index_path(store, path)?;
    if !path.exists() {
        let tx = store.conn.transaction()?;
        tx.execute(
            "DELETE FROM files WHERE path = ?1",
            [path.to_string_lossy().as_ref()],
        )?;
        resolve_edges_tx(&tx)?;
        tx.commit()?;
        return Ok(None);
    }
    if detect_language(&path).is_none() {
        return Ok(None);
    }
    persist_parsed_file(store, parse_file(&path)?)
}

pub fn persist_parsed_file(
    store: &mut SqliteStore,
    mut parsed: ParsedFile,
) -> Result<Option<FileId>, CodeGraphError> {
    parsed.file.path = checked_index_path(store, &parsed.file.path)?;
    let tx = store.conn.transaction()?;
    let id = replace_file_tx(&tx, parsed)?;
    resolve_edges_tx(&tx)?;
    tx.commit()?;
    Ok(Some(id))
}

fn replace_file_tx(
    tx: &rusqlite::Transaction<'_>,
    parsed: ParsedFile,
) -> Result<FileId, CodeGraphError> {
    let file_id = upsert_file_tx(tx, &parsed.file)?;
    // Keep identity for surviving symbols, but invalidate every embedding in a
    // changed file, including body-only edits that leave symbol names intact.
    tx.execute(
        "DELETE FROM embeddings WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id=?1)",
        [file_id.0],
    )?;
    let mut retained = HashSet::new();
    for mut sym in parsed.symbols {
        sym.file_id = file_id;
        retained.insert(upsert_symbol_tx(tx, &sym)?.0);
    }
    let old: Vec<i64> = tx
        .prepare("SELECT id FROM symbols WHERE file_id=?1")?
        .query_map([file_id.0], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for id in old.into_iter().filter(|id| !retained.contains(id)) {
        tx.execute("DELETE FROM symbols WHERE id=?1", [id])?;
    }
    tx.execute("DELETE FROM raw_edges WHERE file_id=?1", [file_id.0])?;
    for edge in parsed.edges {
        tx.execute(
            "INSERT OR IGNORE INTO raw_edges(file_id,target_name,kind) VALUES (?1,?2,?3)",
            rusqlite::params![file_id.0, edge.target_name, format!("{:?}", edge.kind)],
        )?;
    }
    Ok(file_id)
}

/// Retaining unresolved names allows unchanged callers to follow renamed/moved
/// targets and removes both incoming and outgoing obsolete edges atomically.
fn resolve_edges_tx(tx: &rusqlite::Transaction<'_>) -> Result<usize, CodeGraphError> {
    tx.execute("DELETE FROM edges", [])?;
    Ok(tx.execute(
        "INSERT OR IGNORE INTO edges(from_node,to_node,kind)
        SELECT r.file_id,s.id,r.kind FROM raw_edges r JOIN symbols s ON s.name=r.target_name",
        [],
    )?)
}

/// Embed the current symbol body along with its name and documentation. A file
/// hash guards each write against edits that race an asynchronous provider call.
pub async fn embed_pending(
    store: &Arc<Mutex<SqliteStore>>,
    embedder: &dyn Embedder,
    batch_size: usize,
) -> Result<usize, CodeGraphError> {
    let pending: Vec<(SymbolId, String, i64)> = {
        let guard = store.lock();
        let mut stmt = guard.conn.prepare(
            "SELECT s.id,s.kind,s.name,s.docstring,f.path,s.start_byte,s.end_byte,f.content_hash
             FROM symbols s JOIN files f ON f.id=s.file_id
             LEFT JOIN embeddings e ON e.symbol_id=s.id WHERE e.symbol_id IS NULL",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let kind: String = row.get(1)?;
                let name: String = row.get(2)?;
                let doc: Option<String> = row.get(3)?;
                let path: String = row.get(4)?;
                let start: usize = row.get(5)?;
                let end: usize = row.get(6)?;
                let hash: i64 = row.get(7)?;
                Ok((id, kind, name, doc, path, start, end, hash))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut pending = Vec::new();
        for (id, kind, name, doc, path, start, end, hash) in rows {
            let checked = checked_index_path(&guard, Path::new(&path))?;
            let source = std::fs::read_to_string(checked)?;
            if xxhash_rust::xxh3::xxh3_64(source.as_bytes()) as i64 != hash {
                continue;
            }
            let body: String = source
                .get(start..end)
                .unwrap_or("")
                .chars()
                .take(8000)
                .collect();
            pending.push((
                SymbolId(id),
                format!("{kind} {name}\n{}\n{body}", doc.unwrap_or_default()),
                hash,
            ));
        }
        pending
    };
    let mut written = 0;
    for chunk in pending.chunks(batch_size.clamp(1, 256)) {
        let texts: Vec<String> = chunk.iter().map(|(_, text, _)| text.clone()).collect();
        let vectors = embedder.embed(&texts).await?;
        if vectors.len() != chunk.len()
            || vectors
                .iter()
                .any(|v| v.len() != embedder.dimensions() || v.iter().any(|x| !x.is_finite()))
        {
            return Err(CodeGraphError::Parse(
                "embedding provider returned invalid vectors".into(),
            ));
        }
        let mut guard = store.lock();
        for ((sid, _, hash), vector) in chunk.iter().zip(vectors) {
            let current: bool = guard.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.id=?1 AND f.content_hash=?2)",
                rusqlite::params![sid.0, hash], |r| r.get(0),
            )?;
            if current {
                guard.upsert_embedding(*sid, &vector)?;
                written += 1;
            }
        }
    }
    Ok(written)
}

fn collect_source_files(root: &Path) -> Result<Vec<PathBuf>, CodeGraphError> {
    let mut paths = Vec::new();
    for entry in ignore::WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .build()
    {
        let entry = entry.map_err(|e| CodeGraphError::Parse(format!("scan: {e}")))?;
        if entry.file_type().is_some_and(|t| t.is_file()) && detect_language(entry.path()).is_some()
        {
            paths.push(entry.into_path());
        }
    }
    Ok(paths)
}

fn load_existing_hashes(store: &SqliteStore) -> Result<HashMap<String, u64>, CodeGraphError> {
    let mut stmt = store.conn.prepare("SELECT path, content_hash FROM files")?;
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let hash: i64 = row.get(1)?;
        Ok((path, hash as u64))
    })?;
    let mut out = HashMap::new();
    for r in rows {
        let (p, h) = r?;
        out.insert(p, h);
    }
    Ok(out)
}

fn upsert_file_tx(
    tx: &rusqlite::Transaction<'_>,
    file: &FileNode,
) -> Result<FileId, CodeGraphError> {
    let path_str = file.path.to_string_lossy().to_string();
    let language_str = format!("{:?}", file.language);
    let indexed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // ON CONFLICT(path) DO UPDATE preserves the existing row id — important
    // because symbols / edges reference it. Plain INSERT OR REPLACE rotates the
    // id and would cascade-delete every symbol on every re-index.
    tx.execute(
        "INSERT INTO files (path, language, content_hash, indexed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET
             language = excluded.language,
             content_hash = excluded.content_hash,
             indexed_at = excluded.indexed_at",
        rusqlite::params![path_str, language_str, file.content_hash as i64, indexed_at],
    )?;
    let id: i64 = tx.query_row(
        "SELECT id FROM files WHERE path = ?1",
        rusqlite::params![path_str],
        |row| row.get(0),
    )?;
    Ok(FileId(id))
}

fn upsert_symbol_tx(
    tx: &rusqlite::Transaction<'_>,
    sym: &SymbolNode,
) -> Result<SymbolId, CodeGraphError> {
    let name = &sym.name;
    let kind = format!("{:?}", sym.kind);
    let file_id = sym.file_id.0;
    let start_byte = sym.range.0 as i64;
    let end_byte = sym.range.1 as i64;
    let doc_string = sym.doc_string.as_deref();

    // Preserve the existing row id when (file_id, name, kind, start_byte)
    // matches — otherwise `ON DELETE CASCADE` from the `embeddings` table
    // would wipe every cached embedding on every re-index.
    tx.execute(
        "INSERT INTO symbols (file_id, name, kind, start_byte, end_byte, docstring)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(file_id, name, kind, start_byte) DO UPDATE SET
             end_byte = excluded.end_byte,
             docstring = excluded.docstring",
        rusqlite::params![file_id, name, kind, start_byte, end_byte, doc_string],
    )?;
    let id: i64 = tx.query_row(
        "SELECT id FROM symbols
         WHERE file_id = ?1 AND name = ?2 AND kind = ?3 AND start_byte = ?4",
        rusqlite::params![file_id, name, kind, start_byte],
        |row| row.get(0),
    )?;
    Ok(SymbolId(id))
}

// ──────────────────────────────── File watcher ────────────────────────────────

/// Live indexer: holds a `notify` watcher and a debounce task that re-indexes
/// changed files. Dropping the indexer shuts the watcher down cleanly.
pub struct Indexer {
    _watcher: RecommendedWatcher,
    handle: Option<JoinHandle<()>>,
    shutdown_tx: mpsc::Sender<()>,
}

impl Indexer {
    pub async fn start(
        root: PathBuf,
        store: Arc<Mutex<SqliteStore>>,
    ) -> Result<Self, CodeGraphError> {
        let (path_tx, path_rx) = mpsc::channel::<PathBuf>(1024);
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        let watcher = spawn_watcher(&root, path_tx)?;
        let handle = tokio::spawn(debounce_loop(path_rx, shutdown_rx, store, root));

        Ok(Self {
            _watcher: watcher,
            handle: Some(handle),
            shutdown_tx,
        })
    }

    pub async fn shutdown(mut self) {
        let _ = self.shutdown_tx.send(()).await;
        if let Some(h) = self.handle.take() {
            let _ = h.await;
        }
    }
}

impl Drop for Indexer {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.try_send(());
    }
}

fn spawn_watcher(
    root: &Path,
    tx: mpsc::Sender<PathBuf>,
) -> Result<RecommendedWatcher, CodeGraphError> {
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            for path in event.paths {
                let _ = tx.blocking_send(path);
            }
        }
    })
    .map_err(|e| CodeGraphError::Parse(format!("watcher: {e}")))?;

    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| CodeGraphError::Parse(format!("watch: {e}")))?;
    Ok(watcher)
}

async fn debounce_loop(
    mut rx: mpsc::Receiver<PathBuf>,
    mut shutdown_rx: mpsc::Receiver<()>,
    store: Arc<Mutex<SqliteStore>>,
    root: PathBuf,
) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    let debounce = Duration::from_millis(200);
    let mut deadline: Option<tokio::time::Instant> = None;

    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => break,
            maybe = rx.recv() => {
                match maybe {
                    Some(p) => {
                        if detect_language(&p).is_some() || p.extension().is_none() || p.file_name().is_some_and(|name| name == ".gitignore" || name == "index") {
                            pending.insert(p);
                            deadline = Some(tokio::time::Instant::now() + debounce);
                        }
                    }
                    None => break,
                }
            }
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)),
                if deadline.is_some() => {
                if !pending.is_empty() {
                    pending.clear();
                    let store = store.clone();
                    let root = root.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Err(error) = bulk_index(&mut store.lock(), &root) {
                            tracing::warn!(%error, "workspace reconciliation failed");
                        }
                    }).await;
                }
                deadline = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SymbolKind;

    fn write(path: &Path, content: &str) {
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn bulk_index_indexes_a_directory() {
        let dir = tempfile::TempDir::new().unwrap();
        write(
            &dir.path().join("a.rs"),
            "fn alpha() {}\nfn beta() { alpha(); }\n",
        );
        write(&dir.path().join("b.py"), "def gamma():\n    pass\n");
        write(&dir.path().join("ignored.txt"), "not source\n");

        let db = dir.path().join("graph.db");
        let mut store = SqliteStore::new(db.to_str().unwrap()).unwrap();
        let stats = bulk_index(&mut store, dir.path()).unwrap();

        assert_eq!(stats.files, 2);
        assert!(stats.symbols >= 3);
        assert!(stats.edges >= 1, "should resolve at least one call edge");
        assert_eq!(stats.skipped_unchanged, 0);

        // Symbol lookup smoke
        let n: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM symbols WHERE name = 'alpha'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn bulk_index_skips_unchanged_files_on_rerun() {
        let dir = tempfile::TempDir::new().unwrap();
        write(&dir.path().join("a.rs"), "fn alpha() {}\n");

        let db = dir.path().join("graph.db");
        let mut store = SqliteStore::new(db.to_str().unwrap()).unwrap();
        let first = bulk_index(&mut store, dir.path()).unwrap();
        assert_eq!(first.files, 1);
        assert_eq!(first.skipped_unchanged, 0);

        let second = bulk_index(&mut store, dir.path()).unwrap();
        assert_eq!(second.files, 0);
        assert_eq!(second.skipped_unchanged, 1);
    }

    #[test]
    fn bulk_index_reindexes_changed_files() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("a.rs");
        write(&path, "fn alpha() {}\n");

        let db = dir.path().join("graph.db");
        let mut store = SqliteStore::new(db.to_str().unwrap()).unwrap();
        let _ = bulk_index(&mut store, dir.path()).unwrap();

        write(&path, "fn alpha() {}\nfn beta() {}\n");
        let stats = bulk_index(&mut store, dir.path()).unwrap();
        assert_eq!(stats.files, 1);

        let n: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM symbols WHERE name IN ('alpha','beta')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn index_one_file_persists_a_single_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("a.rs");
        write(&path, "fn alpha() {}\n");

        let db = dir.path().join("graph.db");
        let mut store = SqliteStore::new(db.to_str().unwrap()).unwrap();
        let id = index_one_file(&mut store, &path).unwrap();
        assert!(id.is_some());

        let n: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM symbols", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    fn count(store: &SqliteStore, table: &str) -> i64 {
        store
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn reconcile_edits_moves_removals_and_incoming_references() {
        let dir = tempfile::TempDir::new().unwrap();
        let target = dir.path().join("target.rs");
        let caller = dir.path().join("caller.rs");
        write(&target, "fn alpha() {}\n");
        write(&caller, "fn caller() { alpha(); }\n");
        let mut store = SqliteStore::new(":memory:").unwrap();
        bulk_index(&mut store, dir.path()).unwrap();
        assert_eq!(count(&store, "edges"), 1);
        let sid = store
            .conn
            .query_row("SELECT id FROM symbols WHERE name='alpha'", [], |r| {
                r.get(0)
            })
            .unwrap();
        store.upsert_embedding(SymbolId(sid), &[1.0, 0.0]).unwrap();
        write(&target, "// moved offset\nfn alpha() { let x = 1; }\n");
        index_one_file(&mut store, &target).unwrap();
        assert_eq!(
            (
                count(&store, "symbols"),
                count(&store, "edges"),
                count(&store, "embeddings")
            ),
            (2, 1, 0)
        );
        std::fs::rename(&target, dir.path().join("moved.rs")).unwrap();
        bulk_index(&mut store, dir.path()).unwrap();
        assert_eq!(
            (
                count(&store, "files"),
                count(&store, "symbols"),
                count(&store, "edges")
            ),
            (2, 2, 1)
        );
        write(&caller, "fn caller() {}\n");
        index_one_file(&mut store, &caller).unwrap();
        assert_eq!(count(&store, "edges"), 0);
        std::fs::remove_file(dir.path().join("moved.rs")).unwrap();
        index_one_file(&mut store, &dir.path().join("moved.rs")).unwrap();
        assert_eq!((count(&store, "files"), count(&store, "symbols")), (1, 1));
        write(&caller, "fn renamed() {}\n");
        bulk_index(&mut store, dir.path()).unwrap();
        assert_eq!(count(&store, "symbols WHERE name='caller'"), 0);
    }

    #[test]
    fn rejects_other_workspace_and_ignores_dependencies() {
        let a = tempfile::TempDir::new().unwrap();
        let b = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(a.path().join(".git")).unwrap();
        write(&a.path().join(".gitignore"), "node_modules/\n");
        std::fs::create_dir(a.path().join("node_modules")).unwrap();
        write(
            &a.path().join("node_modules/dependency.rs"),
            "fn ignored() {}\n",
        );
        write(&a.path().join("a.rs"), "fn alpha() {}\n");
        write(&b.path().join("b.rs"), "fn beta() {}\n");
        let mut store = SqliteStore::new(":memory:").unwrap();
        bulk_index(&mut store, a.path()).unwrap();
        assert!(bulk_index(&mut store, b.path()).is_err());
        assert!(index_one_file(&mut store, &b.path().join("b.rs")).is_err());
        assert_eq!(count(&store, "symbols"), 1);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_indexing() {
        let dir = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        write(&outside.path().join("secret.rs"), "fn secret() {}\n");
        let link = dir.path().join("link.rs");
        std::os::unix::fs::symlink(outside.path().join("secret.rs"), &link).unwrap();
        let mut store = SqliteStore::new(":memory:").unwrap();
        bulk_index(&mut store, dir.path()).unwrap();
        assert!(index_one_file(&mut store, &link).is_err());
        assert_eq!(count(&store, "symbols"), 0);
    }

    #[allow(dead_code)]
    fn _kind_witness() -> SymbolKind {
        SymbolKind::Function
    }
}
