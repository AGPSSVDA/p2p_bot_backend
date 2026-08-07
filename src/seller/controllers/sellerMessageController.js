/**
 * Seller chat-message templates (Method 1 & 2) — CRUD scoped to the 'seller'
 * category of the shared template_groups / template_messages tables.
 *
 * Mirrors the buyer-side templateController but only ever touches seller rows, so
 * the buyer "Chat Templates" page and the seller "Chat Messages" page stay
 * separate. Editing invalidates the sellerMessageService cache so changes apply
 * within ~30s (immediately on the next send after invalidate()).
 */

const { pool } = require('../../config/mysql');
const sellerMessageService = require('../services/sellerMessageService');

const CATEGORY = 'seller';

// GET /api/seller/messages — all seller template groups with their messages.
const getMessages = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT g.id AS group_id, g.template_key, g.small_description, g.sort_order,
              m.id AS message_id, m.message_text, m.step_order
       FROM template_groups g
       LEFT JOIN template_messages m ON g.id = m.template_id
       WHERE g.category = ?
       ORDER BY g.sort_order ASC, g.template_key ASC, m.step_order ASC`,
      [CATEGORY]
    );

    const templates = rows.reduce((acc, row) => {
      let group = acc.find((g) => g.template_key === row.template_key);
      if (!group) {
        group = {
          id: row.group_id,
          template_key: row.template_key,
          small_description: row.small_description,
          sort_order: row.sort_order,
          messages: [],
        };
        acc.push(group);
      }
      if (row.message_id) {
        group.messages.push({
          id: row.message_id,
          message_text: row.message_text,
          step_order: row.step_order,
        });
      }
      return acc;
    }, []);

    res.json({ success: true, message: 'Seller messages retrieved', data: templates });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
};

// GET /api/seller/messages/variables — the {token} palette for seller templates.
const getVariables = async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Seller template variables retrieved',
      data: sellerMessageService.TEMPLATE_VARIABLES.map((v) => ({
        token: `{${v.name}}`,
        name: v.name,
        example: v.example,
        description: v.description,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
};

// POST /api/seller/messages — add NEW message variations to a seller key.
const createMessages = async (req, res) => {
  try {
    const { template_key, messages } = req.body;
    if (!template_key || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing template_key or messages', data: null });
    }

    // Group must exist AND be a seller group — never let this touch buyer rows.
    const [groups] = await pool.query(
      'SELECT id FROM template_groups WHERE template_key = ? AND category = ?',
      [template_key, CATEGORY]
    );
    if (groups.length === 0) {
      return res.status(404).json({ success: false, message: 'Seller template key not found', data: null });
    }
    const groupId = groups[0].id;

    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      const added = [];
      for (const msg of messages) {
        if (!msg.message_text || msg.step_order === undefined) {
          throw new Error('Each message must have message_text and step_order');
        }
        const [existing] = await conn.query(
          'SELECT id FROM template_messages WHERE template_id = ? AND step_order = ?',
          [groupId, msg.step_order]
        );
        if (existing.length > 0) {
          throw new Error(`Step order ${msg.step_order} already exists for this key`);
        }
        const [r] = await conn.query(
          'INSERT INTO template_messages (template_id, message_text, step_order) VALUES (?, ?, ?)',
          [groupId, msg.message_text, msg.step_order]
        );
        added.push({ id: r.insertId, step_order: msg.step_order });
      }
      await conn.commit();
      sellerMessageService.invalidate();
      res.status(201).json({ success: true, message: 'Messages added', data: { template_key, added } });
    } catch (err) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: err.message, data: null });
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
};

// PUT /api/seller/messages — edit/reorder EXISTING messages for a seller key.
const updateMessages = async (req, res) => {
  try {
    const { template_key, messages } = req.body;
    if (!template_key || !Array.isArray(messages)) {
      return res.status(400).json({ success: false, message: 'Missing template_key or messages', data: null });
    }

    const [groups] = await pool.query(
      'SELECT id FROM template_groups WHERE template_key = ? AND category = ?',
      [template_key, CATEGORY]
    );
    if (groups.length === 0) {
      return res.status(404).json({ success: false, message: 'Seller template key not found', data: null });
    }
    const groupId = groups[0].id;

    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      for (const msg of messages) {
        if (!msg.id || !msg.message_text || msg.step_order === undefined) {
          throw new Error('Each message must have id, message_text and step_order');
        }
        await conn.query(
          'UPDATE template_messages SET message_text = ?, step_order = ? WHERE id = ? AND template_id = ?',
          [msg.message_text, msg.step_order, msg.id, groupId]
        );
      }
      await conn.commit();
      sellerMessageService.invalidate();
      res.json({ success: true, message: 'Messages updated', data: null });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
};

// DELETE /api/seller/messages/:id — delete one message variation (seller only).
const deleteMessage = async (req, res) => {
  try {
    const { id } = req.params;
    // Only delete if the message belongs to a SELLER group.
    const [r] = await pool.query(
      `DELETE m FROM template_messages m
       JOIN template_groups g ON g.id = m.template_id
       WHERE m.id = ? AND g.category = ?`,
      [id, CATEGORY]
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Seller message not found', data: null });
    }
    sellerMessageService.invalidate();
    res.json({ success: true, message: 'Message deleted', data: null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: null });
  }
};

module.exports = { getMessages, getVariables, createMessages, updateMessages, deleteMessage };
