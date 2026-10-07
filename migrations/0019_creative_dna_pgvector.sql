-- Creative DNA v2: pgvector extension and multimodal embeddings

create extension if not exists vector;

alter table creative_dna
  add column if not exists embedding vector(384);

create index if not exists creative_dna_embedding_idx
  on creative_dna using hnsw (embedding vector_cosine_ops);
