// 管理端用户、内容、公告与统计。路径对齐 Agen nova-admin 的 DEFAULT_ENDPOINT_MAP。
import {randomBytes} from 'node:crypto';
import {ApiError} from './errors.mjs';
import {hashPassword} from './auth.mjs';
import {generateNicknames, looksLow} from './nicknames.mjs';

function asInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

export function createAdminOps(db, {now, vip, profile, pay, audit} = {}) {
  const nowFn = now || Date.now;

  function userRow(u) {
    if (!u) return null;
    const p = profile ? profile.publicOf(u) : {};
    const st = vip ? vip.status(u) : {active: !!(u.vip_until && u.vip_until > nowFn()), until: u.vip_until};
    const posts = db.prepare('SELECT COUNT(*) n FROM posts WHERE author_id=? AND deleted_at IS NULL').get(u.id).n;
    const name = (p && p.displayName) || u.username;
    const kind = u.account_kind === 'ai' ? 'ai' : 'human';
    return {
      id: u.id,
      userId: u.id,
      username: u.username,
      name,
      displayName: name,
      display_name: name,
      email: u.email,
      status: u.status || 'active',
      banned: u.status === 'banned',
      vip: !!st.active,
      isVip: !!st.active,
      vipUntil: st.active ? st.until : (u.vip_until || null),
      vip_until: st.active ? st.until : (u.vip_until || null),
      vipSource: u.vip_source || null,
      createdAt: u.created_at,
      joinedAt: u.created_at,
      lastLoginAt: u.last_login_at || null,
      lastLogin: u.last_login_at || null,
      role: u.role,
      kind,
      accountKind: kind,
      isAi: kind === 'ai',
      lowName: kind === 'ai' && looksLow(name),
      mustChangePw: !!u.must_change_pw,
      avatar: p && p.avatar ? p.avatar : '',
      bio: (p && p.bio) || '',
      posts,
      canPost: u.status === 'active',
      canComment: u.status === 'active',
    };
  }

  function getUser(id) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(asInt(id));
    if (!u) throw new ApiError(404, 'NOT_FOUND', '用户不存在');
    return u;
  }

  function listUsers(q = {}) {
    const rawLimit = q.limit;
    const numeric = Number(rawLimit);
    // 旧客户端把上限写成 100，服务端再卡一次，AI 账号一多就把更早的真人挤出列表。
    // 不传、0、all，或仍传 >=100，都视为要完整列表。更小的 limit 仍按 id 游标分页。
    const unbounded = rawLimit == null || rawLimit === '' || String(rawLimit).toLowerCase() === 'all' || numeric === 0 || numeric >= 100;
    const limit = unbounded ? null : Math.max(1, Math.floor(numeric) || 1);
    const cursor = !unbounded && q.cursor != null && q.cursor !== '' ? asInt(q.cursor) : null;
    const status = String(q.status || '').trim();
    const search = String(q.q || q.query || q.search || '').trim();
    const kindQ = String(q.kind || q.accountKind || 'all').trim().toLowerCase();
    const where = [], args = [];
    if (status === 'banned' || status === 'active') { where.push('u.status=?'); args.push(status); }
    else if (status === 'vip') { where.push('u.vip_until IS NOT NULL AND u.vip_until>?'); args.push(nowFn()); }
    if (search) {
      where.push('(u.username LIKE ? OR u.email LIKE ? OR IFNULL(p.display_name,"") LIKE ?)');
      const like = '%' + search.replace(/%/g, '') + '%';
      args.push(like, like, like);
    }
    const countWhere = where.slice();
    const countArgs = args.slice();
    if (kindQ === 'human' || kindQ === 'real' || kindQ === 'user') where.push("IFNULL(u.account_kind,'human')='human'");
    else if (kindQ === 'ai' || kindQ === 'bot') where.push("u.account_kind='ai'");
    else if (kindQ && kindQ !== 'all') throw new ApiError(400, 'BAD_KIND', 'kind 只能是 all、human 或 ai');
    if (cursor != null && Number.isFinite(cursor)) { where.push('u.id<?'); args.push(cursor); }
    const order = unbounded
      ? "ORDER BY CASE WHEN IFNULL(u.account_kind,'human')='ai' THEN 1 ELSE 0 END, u.id DESC"
      : 'ORDER BY u.id DESC';
    const sql = `SELECT u.* FROM users u LEFT JOIN profiles p ON p.user_id=u.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${order}` + (limit ? ' LIMIT ?' : '');
    const rows = limit ? db.prepare(sql).all(...args, limit + 1) : db.prepare(sql).all(...args);
    const more = limit ? rows.length > limit : false;
    const slice = more ? rows.slice(0, limit) : rows;
    const users = slice.map(userRow);
    const grouped = {
      human: users.filter(u => u.kind === 'human'),
      ai: users.filter(u => u.kind === 'ai'),
    };
    const countSql = `SELECT IFNULL(u.account_kind,'human') k, COUNT(*) n FROM users u LEFT JOIN profiles p ON p.user_id=u.id
      ${countWhere.length ? 'WHERE ' + countWhere.join(' AND ') : ''} GROUP BY k`;
    const counts = {human: 0, ai: 0, total: 0, shown: users.length};
    for (const row of db.prepare(countSql).all(...countArgs)) {
      if (row.k === 'ai') counts.ai = row.n;
      else counts.human += row.n;
    }
    counts.total = counts.human + counts.ai;
    return {
      users,
      members: users,
      humans: grouped.human,
      aiUsers: grouped.ai,
      counts,
      limit: limit,
      truncated: more,
      nextCursor: more ? slice[slice.length - 1].id : null,
    };
  }

  function oneUser(id) {
    return {user: userRow(getUser(id))};
  }

  function ban(admin, id, body = {}, ip = null) {
    const u = getUser(id);
    if (u.status === 'banned') return {user: userRow(u), already: true};
    const reason = String(body.reason || body.note || '').trim().slice(0, 500);
    db.prepare("UPDATE users SET status='banned' WHERE id=?").run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    if (audit) audit(admin.id, 'admin.user.ban', 'user:' + u.id, ip, {reason, username: u.username, adminUsername: admin.username});
    return {user: userRow(getUser(u.id)), already: false};
  }

  function unban(admin, id, body = {}, ip = null) {
    const u = getUser(id);
    if (u.status !== 'banned') return {user: userRow(u), already: true};
    const reason = String(body.reason || body.note || '').trim().slice(0, 500);
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(u.id);
    if (audit) audit(admin.id, 'admin.user.unban', 'user:' + u.id, ip, {reason, username: u.username, adminUsername: admin.username});
    return {user: userRow(getUser(u.id)), already: false};
  }

  function resetPassword(admin, id, body = {}, ip = null) {
    const u = getUser(id);
    let pw = String(body.password || body.temporaryPassword || '').trim();
    if (pw) {
      if (!(pw.length >= 8 && pw.length <= 128 && /[A-Za-z]/.test(pw) && /\d/.test(pw))) {
        throw new ApiError(400, 'WEAK_PASSWORD', '指定密码需 8–128 位且同时包含字母和数字');
      }
    } else {
      pw = 'Tmp' + randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x') + '1a';
    }
    db.prepare('UPDATE users SET password_hash=?, must_change_pw=1 WHERE id=?').run(hashPassword(pw), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    if (audit) audit(admin.id, 'admin.user.reset_password', 'user:' + u.id, ip, {username: u.username, adminUsername: admin.username});
    return {user: userRow(getUser(u.id)), temporaryPassword: pw, mustChangePw: true};
  }

  function grantVip(admin, body = {}, ip = null) {
    const id = body.userId || body.user_id || body.id;
    const u = getUser(id);
    if (u.status === 'banned') throw new ApiError(409, 'BANNED', '封禁账号不能开通会员');
    const days = Number(body.days);
    if (!(Number.isInteger(days) && days > 0)) throw new ApiError(400, 'BAD_DAYS', '请填写开通天数');
    const reason = String(body.reason || body.note || '').trim();
    if (!reason) throw new ApiError(400, 'BAD_REASON', '请填写原因');
    const updated = vip.grant(u.id, {days, source: 'admin', actorId: admin.id, note: reason.slice(0, 500)});
    if (audit) audit(admin.id, 'admin.vip.grant', 'user:' + u.id, ip, {days, reason: reason.slice(0, 200), adminUsername: admin.username});
    return {user: userRow(updated)};
  }

  function revokeVip(admin, body = {}, ip = null) {
    const id = body.userId || body.user_id || body.id;
    const u = getUser(id);
    const reason = String(body.reason || body.note || '').trim();
    if (!reason) throw new ApiError(400, 'BAD_REASON', '请填写原因');
    const updated = vip.revoke(u.id, {source: 'admin', actorId: admin.id, note: reason.slice(0, 500)});
    if (audit) audit(admin.id, 'admin.vip.revoke', 'user:' + u.id, ip, {reason: reason.slice(0, 200), adminUsername: admin.username});
    return {user: userRow(updated)};
  }

  function pubPost(row) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(row.author_id);
    const p = u && profile ? profile.publicOf(u) : {};
    return {
      id: row.id,
      type: 'post',
      text: row.text,
      title: String(row.text || '').slice(0, 40),
      authorId: row.author_id,
      author: u ? {id: u.id, username: u.username, displayName: ((p && p.displayName && String(p.displayName).trim()) || u.username)} : null,
      createdAt: row.created_at,
      createdAtUtc: new Date(row.created_at).toISOString(),
      updatedAt: row.updated_at || null,
      deleted: !!row.deleted_at,
      deletedAt: row.deleted_at || null,
      status: row.deleted_at ? 'removed' : 'approved',
      adminHidden: !!row.admin_hidden,
      adminReason: row.admin_reason || null,
      adminActorId: row.admin_actor_id || null,
    };
  }
  function commentThread(row) {
    let depth = 0, rootId = row.id, walk = row, replyTo = null, guard = 0;
    const by = db.prepare('SELECT * FROM post_comments WHERE id=?');
    if (row.parent_id) {
      const p = by.get(row.parent_id);
      if (p) {
        const pu = db.prepare('SELECT * FROM users WHERE id=?').get(p.author_id);
        const pp = pu && profile ? profile.publicOf(pu) : {};
        replyTo = {
          id: p.id,
          deleted: !!p.deleted_at,
          author: pu ? {id: pu.id, username: pu.username, displayName: (pp && pp.displayName) || pu.username} : null,
          text: p.deleted_at ? '' : String(p.text || '').slice(0, 80),
        };
      } else {
        replyTo = {id: row.parent_id, deleted: true, missing: true, author: null, text: ''};
      }
    }
    while (walk && walk.parent_id && guard++ < 30) {
      const p = by.get(walk.parent_id);
      if (!p) break;
      depth++;
      rootId = p.parent_id ? rootId : p.id;
      if (!p.parent_id) rootId = p.id;
      walk = p;
    }
    if (row.parent_id && depth === 0) depth = 1;
    // recompute root properly
    walk = row; rootId = row.id; depth = 0; guard = 0;
    while (walk && walk.parent_id && guard++ < 30) {
      const p = by.get(walk.parent_id);
      if (!p) break;
      depth++;
      rootId = p.id;
      walk = p;
    }
    const replyCount = db.prepare('SELECT COUNT(*) AS n FROM post_comments WHERE parent_id=? AND deleted_at IS NULL').get(row.id).n;
    return {depth, rootId, replyTo, replyCount, parentId: row.parent_id || null};
  }
  function pubComment(row) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(row.author_id);
    const p = u && profile ? profile.publicOf(u) : {};
    const th = commentThread(row);
    return {
      id: row.id,
      type: 'comment',
      text: row.text,
      title: String(row.text || '').slice(0, 40),
      postId: row.post_id,
      parentId: th.parentId,
      rootId: th.rootId,
      depth: th.depth,
      replyTo: th.replyTo,
      replyCount: th.replyCount,
      authorId: row.author_id,
      author: u ? {id: u.id, username: u.username, displayName: (p && p.displayName) || u.username} : null,
      createdAt: row.created_at,
      createdAtUtc: new Date(row.created_at).toISOString(),
      deleted: !!row.deleted_at,
      deletedAt: row.deleted_at || null,
      status: row.deleted_at ? 'removed' : 'approved',
      adminHidden: !!row.admin_hidden,
      adminReason: row.admin_reason || null,
      adminActorId: row.admin_actor_id || null,
    };
  }

  function listContent(q = {}) {
    const type = String(q.type || 'post').trim() || 'post';
    const status = String(q.status || 'all').trim();
    const search = String(q.q || q.query || '').trim();
    const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 100);
    const cursor = q.cursor != null && q.cursor !== '' ? String(q.cursor) : null;
    if (type !== 'post' && type !== 'comment') throw new ApiError(400, 'BAD_TYPE', 'type 须为 post 或 comment');
    const table = type === 'post' ? 'posts' : 'post_comments';
    const where = [], args = [];
    if (status === 'removed' || status === 'deleted') where.push('deleted_at IS NOT NULL');
    else if (status === 'visible' || status === 'approved') where.push('deleted_at IS NULL');
    if (search) { where.push('text LIKE ?'); args.push('%' + search.replace(/%/g, '') + '%'); }
    if (cursor) { where.push('created_at<?'); args.push(Number(cursor) || 0); }
    const sql = `SELECT * FROM ${table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...args, limit + 1);
    const more = rows.length > limit;
    const slice = more ? rows.slice(0, limit) : rows;
    const items = slice.map(r => type === 'post' ? pubPost(r) : pubComment(r));
    return {items, posts: type === 'post' ? items : undefined, comments: type === 'comment' ? items : undefined, nextCursor: more ? String(slice[slice.length - 1].created_at) : null};
  }

  function getContent(type, id) {
    if (type === 'post') {
      const row = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '动态不存在');
      return {item: pubPost(row)};
    }
    if (type === 'comment') {
      const row = db.prepare('SELECT * FROM post_comments WHERE id=?').get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '评论不存在');
      return {item: pubComment(row)};
    }
    throw new ApiError(400, 'BAD_TYPE', 'type 须为 post 或 comment');
  }

  function hideContent(admin, type, id, body = {}, ip = null) {
    const reason = String(body.reason || body.note || '').trim().slice(0, 500);
    const at = nowFn();
    if (type === 'post') {
      const row = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '动态不存在');
      if (row.deleted_at && row.admin_hidden) {
        return {item: pubPost(row), already: true};
      }
      db.prepare('UPDATE posts SET deleted_at=COALESCE(deleted_at,?), admin_hidden=1, admin_reason=?, admin_actor_id=? WHERE id=?')
        .run(at, reason, admin.id, id);
      if (audit) audit(admin.id, 'admin.content.delete', 'post:' + id, ip, {reason, adminUsername: admin.username});
      return {item: pubPost(db.prepare('SELECT * FROM posts WHERE id=?').get(id)), already: false};
    }
    if (type === 'comment') {
      const row = db.prepare('SELECT * FROM post_comments WHERE id=?').get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '评论不存在');
      if (row.deleted_at && row.admin_hidden) return {item: pubComment(row), already: true};
      db.prepare('UPDATE post_comments SET deleted_at=COALESCE(deleted_at,?), admin_hidden=1, admin_reason=?, admin_actor_id=? WHERE id=?')
        .run(at, reason, admin.id, id);
      if (audit) audit(admin.id, 'admin.content.delete', 'comment:' + id, ip, {reason, adminUsername: admin.username});
      return {item: pubComment(db.prepare('SELECT * FROM post_comments WHERE id=?').get(id)), already: false};
    }
    throw new ApiError(400, 'BAD_TYPE', 'type 须为 post 或 comment');
  }

  function restoreContent(admin, type, id, body = {}, ip = null) {
    if (type === 'post') {
      const row = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '动态不存在');
      if (!row.deleted_at) return {item: pubPost(row), already: true};
      db.prepare('UPDATE posts SET deleted_at=NULL, admin_hidden=0, admin_reason=NULL, admin_actor_id=? WHERE id=?').run(admin.id, id);
      if (audit) audit(admin.id, 'admin.content.restore', 'post:' + id, ip, {adminUsername: admin.username});
      return {item: pubPost(db.prepare('SELECT * FROM posts WHERE id=?').get(id)), already: false};
    }
    if (type === 'comment') {
      const row = db.prepare('SELECT * FROM post_comments WHERE id=?').get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '评论不存在');
      if (!row.deleted_at) return {item: pubComment(row), already: true};
      db.prepare('UPDATE post_comments SET deleted_at=NULL, admin_hidden=0, admin_reason=NULL, admin_actor_id=? WHERE id=?').run(admin.id, id);
      if (audit) audit(admin.id, 'admin.content.restore', 'comment:' + id, ip, {adminUsername: admin.username});
      return {item: pubComment(db.prepare('SELECT * FROM post_comments WHERE id=?').get(id)), already: false};
    }
    throw new ApiError(400, 'BAD_TYPE', 'type 须为 post 或 comment');
  }

  function stats() {
    const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    const banned = db.prepare("SELECT COUNT(*) n FROM users WHERE status='banned'").get().n;
    const vipN = db.prepare('SELECT COUNT(*) n FROM users WHERE vip_until IS NOT NULL AND vip_until>?').get(nowFn()).n;
    const humanN = db.prepare("SELECT COUNT(*) n FROM users WHERE IFNULL(account_kind,'human')<>'ai'").get().n;
    const aiN = db.prepare("SELECT COUNT(*) n FROM users WHERE account_kind='ai'").get().n;
    const postsVis = db.prepare('SELECT COUNT(*) n FROM posts WHERE deleted_at IS NULL').get().n;
    const postsHid = db.prepare('SELECT COUNT(*) n FROM posts WHERE deleted_at IS NOT NULL').get().n;
    const commentsVis = db.prepare('SELECT COUNT(*) n FROM post_comments WHERE deleted_at IS NULL').get().n;
    const reportsPending = (() => {
      try { return db.prepare("SELECT COUNT(*) n FROM reports WHERE status='pending'").get().n; }
      catch { return 0; }
    })();
    let payPending = 0, payReview = 0;
    if (pay) {
      pay.expire();
      payPending = db.prepare("SELECT COUNT(*) n FROM pay_orders WHERE status='pending'").get().n;
      payReview = db.prepare("SELECT COUNT(*) n FROM pay_orders WHERE status='awaiting_review'").get().n;
    }
    return {
      users: {total: users, active: users - banned, banned, vip: vipN, human: humanN, ai: aiN},
      posts: {visible: postsVis, removed: postsHid},
      comments: {visible: commentsVis},
      reports: {pending: reportsPending},
      payments: {pending: payPending, awaitingReview: payReview},
    };
  }

  function listAnnouncements(q = {}) {
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
    const rows = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT ?').all(limit);
    return {announcements: rows.map(pubAnn)};
  }
  function addAnnouncement(admin, body = {}, ip = null) {
    const title = String(body.title || '').trim();
    const text = String(body.body || body.content || '').trim();
    if (!title) throw new ApiError(400, 'BAD_TITLE', '请填写公告标题');
    if (!text) throw new ApiError(400, 'BAD_BODY', '请填写公告内容');
    const at = nowFn();
    const r = db.prepare('INSERT INTO announcements(title,body,created_at,published,author_admin_id) VALUES(?,?,?,?,?)')
      .run(title.slice(0, 120), text.slice(0, 8000), at, body.published === false ? 0 : 1, admin.id);
    if (audit) audit(admin.id, 'admin.announcement.create', 'announcement:' + r.lastInsertRowid, ip, {title, adminUsername: admin.username});
    return listAnnouncements();
  }
  function pubAnn(r) {
    return {
      id: r.id, title: r.title, body: r.body, published: !!r.published,
      createdAt: r.created_at,
      createdAtUtc: r.created_at != null ? new Date(r.created_at).toISOString() : null,
      updatedAt: r.updated_at || null,
      updatedAtUtc: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      authorAdminId: r.author_admin_id,
      withdrawn: !r.published,
    };
  }
  function removeAnnouncement(admin, id, ip = null) {
    const row = db.prepare('SELECT * FROM announcements WHERE id=?').get(asInt(id));
    if (!row) throw new ApiError(404, 'NOT_FOUND', '公告不存在');
    db.prepare('DELETE FROM announcements WHERE id=?').run(row.id);
    if (audit) audit(admin.id, 'admin.announcement.delete', 'announcement:' + row.id, ip, {adminUsername: admin.username});
    return {deleted: row.id};
  }
  function editAnnouncement(admin, id, body = {}, ip = null) {
    const row = db.prepare('SELECT * FROM announcements WHERE id=?').get(asInt(id));
    if (!row) throw new ApiError(404, 'NOT_FOUND', '公告不存在');
    const title = body.title != null ? String(body.title).trim() : row.title;
    const text = body.body != null || body.content != null ? String(body.body || body.content).trim() : row.body;
    if (!title) throw new ApiError(400, 'BAD_TITLE', '请填写公告标题');
    if (!text) throw new ApiError(400, 'BAD_BODY', '请填写公告内容');
    let published = row.published;
    if (body.published != null) published = body.published ? 1 : 0;
    db.prepare('UPDATE announcements SET title=?, body=?, published=?, updated_at=? WHERE id=?')
      .run(title.slice(0, 120), text.slice(0, 8000), published, nowFn(), row.id);
    if (audit) audit(admin.id, 'admin.announcement.edit', 'announcement:' + row.id, ip, {title, published: !!published, adminUsername: admin.username});
    return {announcement: pubAnn(db.prepare('SELECT * FROM announcements WHERE id=?').get(row.id))};
  }
  function withdrawAnnouncement(admin, id, ip = null) {
    const row = db.prepare('SELECT * FROM announcements WHERE id=?').get(asInt(id));
    if (!row) throw new ApiError(404, 'NOT_FOUND', '公告不存在');
    if (!row.published) return {announcement: pubAnn(row), already: true};
    db.prepare('UPDATE announcements SET published=0, updated_at=? WHERE id=?').run(nowFn(), row.id);
    if (audit) audit(admin.id, 'admin.announcement.withdraw', 'announcement:' + row.id, ip, {adminUsername: admin.username});
    return {announcement: pubAnn(db.prepare('SELECT * FROM announcements WHERE id=?').get(row.id)), already: false};
  }

  function listCommunities(q = {}) {
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
    const rows = db.prepare(`SELECT * FROM communities WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`).all(limit);
    const nMem = db.prepare("SELECT COUNT(*) AS n FROM community_members WHERE community_id=? AND status='active'");
    return {communities: rows.map(r => ({
      id: r.id, name: r.name, description: r.description, visibility: r.visibility,
      ownerId: r.owner_id, memberCount: nMem.get(r.id).n, createdAt: r.created_at,
    }))};
  }
  function getCommunity(id) {
    const row = db.prepare('SELECT * FROM communities WHERE id=?').get(id);
    if (!row || row.deleted_at) throw new ApiError(404, 'NOT_FOUND', '社区不存在');
    const nMem = db.prepare("SELECT COUNT(*) AS n FROM community_members WHERE community_id=? AND status='active'").get(row.id).n;
    const members = db.prepare("SELECT * FROM community_members WHERE community_id=? AND status='active' ORDER BY joined_at").all(row.id).map(m => {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(m.user_id);
      return {userId: m.user_id, username: u && u.username, role: m.role, status: m.status, joinedAt: m.joined_at};
    });
    const chs = db.prepare("SELECT * FROM community_channels WHERE community_id=? AND deleted_at IS NULL ORDER BY created_at").all(row.id);
    const nMsg = db.prepare("SELECT COUNT(*) AS n FROM community_messages WHERE channel_id=?");
    const channels = chs.map(ch => ({
      id: ch.id, name: ch.name, kind: ch.kind, isDefault: !!ch.is_default,
      messageCount: nMsg.get(ch.id).n,
    }));
    return {community: {id: row.id, name: row.name, description: row.description, visibility: row.visibility, ownerId: row.owner_id, memberCount: nMem, createdAt: row.created_at, members, channels}};
  }
  function listChannelMessages(chId, q = {}) {
    const ch = db.prepare('SELECT * FROM community_channels WHERE id=?').get(chId);
    if (!ch || ch.deleted_at) throw new ApiError(404, 'NOT_FOUND', '频道不存在');
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const rows = db.prepare('SELECT * FROM community_messages WHERE channel_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?').all(ch.id, limit);
    return {channel: {id: ch.id, name: ch.name, communityId: ch.community_id, kind: ch.kind},
      messages: rows.reverse().map(r => {
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.author_id);
        return {
          id: r.id, channelId: ch.id, authorId: r.author_id,
          author: u ? {id: u.id, username: u.username, displayName: (profile && profile.publicOf ? (String((profile.publicOf(u).displayName||'')).trim() || u.username) : u.username)} : null,
          text: r.text, createdAt: r.created_at, createdAtUtc: new Date(r.created_at).toISOString(),
        };
      })};
  }

  function handleOf(display) {
    const raw = String(display || '').replace(/[^\p{L}\p{N}_]/gu, '');
    const base = raw.length >= 3 ? raw.slice(0, 20) : ('网友' + raw).slice(0, 20);
    return base.length >= 3 ? base : '网友' + randomBytes(3).toString('hex');
  }

  function setKind(admin, id, body = {}, ip = null) {
    const u = getUser(id);
    const kind = String(body.kind || body.accountKind || '').trim().toLowerCase();
    if (kind !== 'human' && kind !== 'ai') throw new ApiError(400, 'BAD_KIND', 'kind 只能是 human 或 ai');
    db.prepare('UPDATE users SET account_kind=? WHERE id=?').run(kind, u.id);
    if (audit) audit(admin.id, 'admin.user.kind', 'user:' + u.id, ip, {kind, username: u.username, adminUsername: admin.username});
    return {user: userRow(getUser(u.id))};
  }

  async function createAiUsers(admin, body = {}, ip = null) {
    const count = Math.min(200, Math.max(1, Math.floor(Number(body.count ?? body.n ?? 1)) || 1));
    const names = Array.isArray(body.names) && body.names.length
      ? body.names.map(x => String(x || '').trim()).filter(Boolean).slice(0, count)
      : await generateNicknames(count);
    while (names.length < count) names.push(...await generateNicknames(count - names.length));
    const ins = db.prepare(`INSERT INTO users(username,email,password_hash,created_at,account_kind,status,role) VALUES(?,?,?,?, 'ai','active','user')`);
    const takenU = db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE');
    const takenE = db.prepare('SELECT 1 FROM users WHERE email=?');
    const created = [];
    for (let i = 0; i < count; i++) {
      const display = String(names[i] || '晚风收信').trim().slice(0, 12) || '晚风收信';
      let username = handleOf(display);
      let n = 0;
      while (takenU.get(username)) {
        n++;
        const extra = ['呀', '呢', '哦', '呐', '咯'][n % 5];
        username = (handleOf(display).slice(0, 18) + extra + (n > 5 ? String(n % 10) : '')).slice(0, 20);
        if (n > 30) username = ('网友' + randomBytes(4).toString('hex')).slice(0, 20);
      }
      let email = 'ai.' + randomBytes(6).toString('hex') + '@members.nova.invalid';
      while (takenE.get(email)) email = 'ai.' + randomBytes(6).toString('hex') + '@members.nova.invalid';
      const pw = 'Ai' + randomBytes(9).toString('base64url') + '9z';
      const r = ins.run(username, email, hashPassword(pw), nowFn());
      const u = getUser(Number(r.lastInsertRowid));
      if (profile && profile.save) profile.save(u, {displayName: display.slice(0, 20)});
      created.push(userRow(getUser(u.id)));
    }
    if (audit) audit(admin.id, 'admin.ai_users.create', 'ai-users', ip, {count: created.length, adminUsername: admin.username});
    return {users: created, count: created.length, source: process.env.NOVA_NICK_API_KEY ? 'model-or-local' : 'local'};
  }

  async function renameAiUsers(admin, body = {}, ip = null) {
    let targets;
    if (Array.isArray(body.ids) && body.ids.length) {
      targets = body.ids.map(id => getUser(id)).filter(u => u.account_kind === 'ai');
    } else {
      const onlyLow = body.all !== true;
      targets = db.prepare("SELECT * FROM users WHERE account_kind='ai' ORDER BY id").all()
        .filter(u => !onlyLow || looksLow((profile && profile.publicOf(u).displayName) || u.username));
    }
    if (!targets.length) return {users: [], count: 0};
    const cap = Math.min(targets.length, 200);
    targets = targets.slice(0, cap);
    const names = await generateNicknames(targets.length);
    const takenU = db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE');
    const renamed = [];
    for (let i = 0; i < targets.length; i++) {
      const u = targets[i];
      const display = String(names[i] || '晚风收信').trim().slice(0, 12) || '晚风收信';
      if (profile && profile.save) profile.save(u, {displayName: display.slice(0, 20)});
      if (body.renameUsername === true) {
        let username = handleOf(display);
        let n = 0;
        while (true) {
          const row = takenU.get(username);
          if (!row || row.id === u.id) break;
          n++;
          username = (handleOf(display).slice(0, 18) + ['呀', '呢', '哦'][n % 3]).slice(0, 20);
          if (n > 20) { username = u.username; break; }
        }
        if (username !== u.username) db.prepare('UPDATE users SET username=? WHERE id=?').run(username, u.id);
      }
      renamed.push(userRow(getUser(u.id)));
    }
    if (audit) audit(admin.id, 'admin.ai_users.rename', 'ai-users', ip, {count: renamed.length, adminUsername: admin.username});
    return {users: renamed, count: renamed.length};
  }

  return {
    listUsers, oneUser, ban, unban, resetPassword, grantVip, revokeVip,
    setKind, createAiUsers, renameAiUsers,
    listContent, getContent, hideContent, restoreContent,
    stats, listAnnouncements, addAnnouncement, removeAnnouncement, editAnnouncement, withdrawAnnouncement,
    listCommunities, getCommunity, listChannelMessages, userRow,
  };
}
