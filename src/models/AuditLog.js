const mongoose = require('mongoose');

// Who did what, when. Written for platform actions (school created, plan changed, support login)
// and for anything done during a support session. Never edited or deleted by the API.
const auditLogSchema = new mongoose.Schema({
  school:         { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  actor:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  actorRole:      { type: String, default: '' },
  impersonatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  action:         { type: String, required: true },
  targetType:     { type: String, default: '' },
  targetId:       { type: String, default: '' },
  details:        { type: mongoose.Schema.Types.Mixed, default: {} },
  ip:             { type: String, default: '' },
}, { timestamps: { createdAt: true, updatedAt: false } });

auditLogSchema.index({ school: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
