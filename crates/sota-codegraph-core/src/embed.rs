use async_trait::async_trait;
use instant_distance::{Builder, HnswMap, Point, Search};
use std::sync::Arc;

use crate::error::CodeGraphError;
use crate::types::SymbolId;

/// Async embedding source. Implementors must be cheap to share across threads.
#[async_trait]
pub trait Embedder: Send + Sync {
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CodeGraphError>;
    fn dimensions(&self) -> usize;
}

// ────────────────────────────── Local (fastembed) ──────────────────────────────

pub struct LocalEmbedder {
    model: Arc<parking_lot::Mutex<fastembed::TextEmbedding>>,
    dims: usize,
}

impl LocalEmbedder {
    pub fn new(cache_dir: Option<std::path::PathBuf>) -> Result<Self, CodeGraphError> {
        let mut options = fastembed::InitOptions::new(fastembed::EmbeddingModel::BGESmallENV15);
        if let Some(directory) = cache_dir {
            options = options.with_cache_dir(directory);
        }
        let model = fastembed::TextEmbedding::try_new(options)
            .map_err(|e| CodeGraphError::Parse(format!("fastembed init: {e}")))?;
        Ok(Self {
            model: Arc::new(parking_lot::Mutex::new(model)),
            dims: 384,
        })
    }
}

#[async_trait]
impl Embedder for LocalEmbedder {
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CodeGraphError> {
        let texts: Vec<String> = texts.to_vec();
        let model = self.model.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = model.lock();
            guard
                .embed(texts, None)
                .map_err(|e| CodeGraphError::Parse(format!("fastembed embed: {e}")))
        })
        .await
        .map_err(|e| CodeGraphError::Parse(format!("spawn_blocking: {e}")))?
    }

    fn dimensions(&self) -> usize {
        self.dims
    }
}

// ────────────────────────── Provider (OpenAI-compatible) ─────────────────────────

#[derive(Clone)]
pub struct ProviderEmbedder {
    client: reqwest::Client,
    endpoint: String,
    model: String,
    api_key: Option<String>,
    dims: usize,
    requests: Arc<tokio::sync::Semaphore>,
}

impl ProviderEmbedder {
    pub fn new(endpoint: String, model: String, dims: usize, api_key: Option<String>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client configuration"),
            endpoint,
            model,
            api_key,
            dims,
            requests: Arc::new(tokio::sync::Semaphore::new(8)),
        }
    }
}

#[derive(serde::Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(serde::Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedItem>,
}

#[derive(serde::Deserialize)]
struct EmbedItem {
    index: Option<usize>,
    embedding: Vec<f32>,
}

impl ProviderEmbedder {
    async fn embed_bounded(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CodeGraphError> {
        let _permit = self
            .requests
            .acquire()
            .await
            .map_err(|_| CodeGraphError::Parse("embedding request queue closed".into()))?;
        // Accommodate float encodings and normal API metadata without accepting
        // arbitrary provider bodies. Saturation also bounds untrusted dimensions.
        let body_limit = texts
            .len()
            .saturating_mul(self.dims)
            .saturating_mul(32)
            .saturating_add(16 * 1024)
            .min(64 * 1024 * 1024);
        let mut req = self.client.post(&self.endpoint).json(&EmbedRequest {
            model: &self.model,
            input: texts,
        });
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        let mut response = req
            .send()
            .await
            .map_err(|e| CodeGraphError::Parse(format!("embedding http: {}", e.without_url())))?;
        if !response.status().is_success() {
            return Err(CodeGraphError::Parse(format!(
                "embedding provider returned HTTP {}",
                response.status().as_u16()
            )));
        }
        if response
            .content_length()
            .is_some_and(|length| length > body_limit as u64)
        {
            return Err(CodeGraphError::Parse(
                "embedding response exceeds size limit".into(),
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| CodeGraphError::Parse(format!("embedding body: {}", e.without_url())))?
        {
            if chunk.len() > body_limit.saturating_sub(body.len()) {
                return Err(CodeGraphError::Parse(
                    "embedding response exceeds size limit".into(),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let resp: EmbedResponse = serde_json::from_slice(&body)
            .map_err(|e| CodeGraphError::Parse(format!("embedding json: {e}")))?;
        let mut data = resp.data;
        if data.iter().any(|item| item.index.is_some()) {
            data.sort_by_key(|item| item.index);
            if data
                .iter()
                .enumerate()
                .any(|(i, item)| item.index != Some(i))
            {
                return Err(CodeGraphError::Parse(
                    "invalid embedding response indices".into(),
                ));
            }
        }
        if data.len() != texts.len()
            || data.iter().any(|item| {
                item.embedding.len() != self.dims || item.embedding.iter().any(|v| !v.is_finite())
            })
        {
            return Err(CodeGraphError::Parse(
                "invalid embedding response shape".into(),
            ));
        }
        Ok(data.into_iter().map(|i| i.embedding).collect())
    }
}

#[async_trait]
impl Embedder for ProviderEmbedder {
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CodeGraphError> {
        // Include time spent waiting for a request slot in the same deadline.
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.embed_bounded(texts),
        )
        .await
        .map_err(|_| {
            CodeGraphError::Parse("embedding provider timed out (including queue wait)".into())
        })?
    }

    fn dimensions(&self) -> usize {
        self.dims
    }
}

// ──────────────────────────────── HNSW index ────────────────────────────────────

/// Embedding vector wrapped so it can implement `instant_distance::Point`.
/// Uses cosine distance.
#[derive(Clone, Debug)]
pub struct EmbVec(pub Vec<f32>);

impl Point for EmbVec {
    fn distance(&self, other: &Self) -> f32 {
        let n = self.0.len().min(other.0.len());
        let mut dot = 0.0_f32;
        let mut na = 0.0_f32;
        let mut nb = 0.0_f32;
        for i in 0..n {
            let a = self.0[i];
            let b = other.0[i];
            dot += a * b;
            na += a * a;
            nb += b * b;
        }
        let denom = (na.sqrt() * nb.sqrt()).max(f32::EPSILON);
        1.0 - dot / denom
    }
}

pub struct VectorIndex {
    map: HnswMap<EmbVec, i64>,
}

impl VectorIndex {
    /// Build an HNSW index from `(symbol_id, embedding)` pairs.
    pub fn build(items: Vec<(SymbolId, Vec<f32>)>) -> Self {
        let (points, values): (Vec<_>, Vec<_>) =
            items.into_iter().map(|(id, v)| (EmbVec(v), id.0)).unzip();
        let map = Builder::default().build(points, values);
        Self { map }
    }

    /// k-nearest-neighbour query. Returns `(symbol_id, cosine_distance)` pairs.
    pub fn search(&self, query: &[f32], k: usize) -> Vec<(SymbolId, f32)> {
        let qp = EmbVec(query.to_vec());
        let mut search = Search::default();
        self.map
            .search(&qp, &mut search)
            .take(k)
            .map(|item| (SymbolId(*item.value), item.distance))
            .collect()
    }

    pub fn len(&self) -> usize {
        // HnswMap doesn't expose len directly; iterate is the safest portable option.
        self.map.iter().count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn cosine_distance_identical_vectors_is_zero() {
        let a = EmbVec(vec![1.0, 0.0, 0.0]);
        let b = EmbVec(vec![1.0, 0.0, 0.0]);
        let d = a.distance(&b);
        assert!(d.abs() < 1e-6, "distance was {d}");
    }

    #[test]
    fn cosine_distance_orthogonal_is_one() {
        let a = EmbVec(vec![1.0, 0.0, 0.0]);
        let b = EmbVec(vec![0.0, 1.0, 0.0]);
        let d = a.distance(&b);
        assert!((d - 1.0).abs() < 1e-6, "distance was {d}");
    }

    #[test]
    fn hnsw_returns_seed_as_nearest() {
        // Give every item a distinct direction (rotation through 8d space) so cosine
        // distance separates them. With only-magnitude differences vectors would be
        // parallel and the seed wouldn't be uniquely nearest.
        let items: Vec<(SymbolId, Vec<f32>)> = (0..40)
            .map(|i| {
                let theta = (i as f32) * 0.157_079_6;
                let v = vec![theta.cos(), theta.sin(), 0.1 * i as f32, 0.0];
                (SymbolId(i as i64 + 1), v)
            })
            .collect();
        let seed_id = items[17].0;
        let seed_vec = items[17].1.clone();

        let index = VectorIndex::build(items);
        let hits = index.search(&seed_vec, 3);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].0, seed_id, "seed should be nearest");
        assert!(
            hits[0].1 < 1e-3,
            "self-distance should be ~0, got {}",
            hits[0].1
        );
    }

    #[tokio::test]
    async fn provider_embedder_round_trips_against_stub() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "data": [
                { "embedding": [0.1, 0.2, 0.3] },
                { "embedding": [0.4, 0.5, 0.6] },
            ]
        });
        Mock::given(method("POST"))
            .and(path("/v1/embeddings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let url = format!("{}/v1/embeddings", server.uri());
        let embedder = ProviderEmbedder::new(url, "test-model".into(), 3, Some("sk-test".into()));
        let out = embedder
            .embed(&["hello".to_string(), "world".to_string()])
            .await
            .unwrap();

        assert_eq!(out.len(), 2);
        assert_eq!(out[0], vec![0.1, 0.2, 0.3]);
        assert_eq!(out[1], vec![0.4, 0.5, 0.6]);
        assert_eq!(embedder.dimensions(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn provider_deadline_includes_waiting_for_a_request_slot() {
        let embedder =
            ProviderEmbedder::new("http://127.0.0.1:1".into(), "fixture".into(), 3, None);
        let permits = embedder.requests.acquire_many(8).await.unwrap();
        let started = tokio::time::Instant::now();
        let error = embedder
            .embed(&["queued request".into()])
            .await
            .unwrap_err();
        assert!(error.to_string().contains("including queue wait"));
        assert!(started.elapsed() >= std::time::Duration::from_secs(30));
        drop(permits);
        assert_eq!(embedder.requests.available_permits(), 8);
    }
}
