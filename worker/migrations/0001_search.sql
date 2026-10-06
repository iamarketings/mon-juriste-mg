CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    text,
    title,
    number,
    article,
    tokenize = 'unicode61 remove_diacritics 2'
);

DELETE FROM chunks_fts;

INSERT INTO chunks_fts (chunk_id, text, title, number, article)
SELECT
    c.id,
    c.text,
    d.title,
    COALESCE(d.number, ''),
    COALESCE(c.article, '')
FROM chunks AS c
JOIN documents AS d ON d.id = c.document_id;

CREATE TRIGGER IF NOT EXISTS chunks_fts_after_insert
AFTER INSERT ON chunks
BEGIN
    INSERT INTO chunks_fts (chunk_id, text, title, number, article)
    SELECT
        NEW.id,
        NEW.text,
        d.title,
        COALESCE(d.number, ''),
        COALESCE(NEW.article, '')
    FROM documents AS d
    WHERE d.id = NEW.document_id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_after_delete
AFTER DELETE ON chunks
BEGIN
    DELETE FROM chunks_fts WHERE chunk_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_after_update
AFTER UPDATE OF text, article, document_id ON chunks
BEGIN
    DELETE FROM chunks_fts WHERE chunk_id = OLD.id;
    INSERT INTO chunks_fts (chunk_id, text, title, number, article)
    SELECT
        NEW.id,
        NEW.text,
        d.title,
        COALESCE(d.number, ''),
        COALESCE(NEW.article, '')
    FROM documents AS d
    WHERE d.id = NEW.document_id;
END;
