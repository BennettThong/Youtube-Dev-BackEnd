const express = require("express");

module.exports = (pool, admin) => {
  const router = express.Router();

  // ---- Firebase ID token auth middleware ----
  async function requireAuth(req, res, next) {
    try {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Missing token" });
      const decoded = await admin.auth().verifyIdToken(token);
      req.uid = decoded.uid;
      req.user = decoded; // may include name/email/picture
      next();
    } catch (e) {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  // GET top-level comments
  router.get("/videos/:videoId/comments", async (req, res) => {
    const { videoId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const sort = (req.query.sort || "newest").toLowerCase();
    const orderBy =
      sort === "top" ? "like_count DESC, created_at DESC" : "created_at DESC";

    try {
      const { rows } = await pool.query(
        `
        SELECT id, video_id, author_uid, author_name, author_avatar, body,
               parent_id, like_count, reply_count, created_at
        FROM comments
        WHERE video_id = $1 AND parent_id IS NULL
        ORDER BY ${orderBy}
        LIMIT $2
        `,
        [videoId, limit]
      );
      res.json({ comments: rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to load comments" });
    }
  });

  // GET replies for a comment
  router.get("/comments/:commentId/replies", async (req, res) => {
    const { commentId } = req.params;
    try {
      const { rows } = await pool.query(
        `
        SELECT id, video_id, author_uid, author_name, author_avatar, body,
               parent_id, like_count, reply_count, created_at
        FROM comments
        WHERE parent_id = $1
        ORDER BY created_at ASC
        `,
        [commentId]
      );
      res.json({ comments: rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to load replies" });
    }
  });

  // POST create comment or reply
  router.post("/videos/:videoId/comments", requireAuth, async (req, res) => {
    const { videoId } = req.params;
    const { body, parentId } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: "Empty comment" });

    const author_uid = req.uid;
    const author_name = req.user.name || req.user.email || "User";
    const author_avatar = req.user.picture || null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const insert = await client.query(
        `
        INSERT INTO comments (video_id, author_uid, author_name, author_avatar, body, parent_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [videoId, author_uid, author_name, author_avatar, body.trim(), parentId || null]
      );

      if (parentId) {
        await client.query(
          `UPDATE comments SET reply_count = reply_count + 1 WHERE id = $1`,
          [parentId]
        );
      }

      await client.query("COMMIT");
      res.status(201).json({ comment: insert.rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(e);
      res.status(500).json({ error: "Failed to post comment" });
    } finally {
      client.release();
    }
  });

  // POST like/unlike (toggle)
  router.post("/comments/:commentId/like", requireAuth, async (req, res) => {
    const { commentId } = req.params;
    const uid = req.uid;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const ins = await client.query(
        `INSERT INTO comment_likes (comment_id, uid) VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING comment_id`,
        [commentId, uid]
      );

      if (ins.rowCount > 0) {
        await client.query(
          `UPDATE comments SET like_count = like_count + 1 WHERE id = $1`,
          [commentId]
        );
        await client.query("COMMIT");
        return res.json({ liked: true });
      }

      // already liked → unlike
      await client.query(
        `DELETE FROM comment_likes WHERE comment_id = $1 AND uid = $2`,
        [commentId, uid]
      );
      await client.query(
        `UPDATE comments SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1`,
        [commentId]
      );

      await client.query("COMMIT");
      res.json({ liked: false });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(e);
      res.status(500).json({ error: "Failed to toggle like" });
    } finally {
      client.release();
    }
  });

  // DELETE comment (owner only)
  router.delete("/comments/:commentId", requireAuth, async (req, res) => {
    const { commentId } = req.params;
    const uid = req.uid;

    try {
      const { rows } = await pool.query(
        `SELECT author_uid, parent_id FROM comments WHERE id = $1`,
        [commentId]
      );
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      if (rows[0].author_uid !== uid)
        return res.status(403).json({ error: "Forbidden" });

      await pool.query(`DELETE FROM comments WHERE id = $1`, [commentId]);

      if (rows[0].parent_id) {
        await pool.query(
          `UPDATE comments SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1`,
          [rows[0].parent_id]
        );
      }

      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to delete comment" });
    }
  });

  return router;
};
