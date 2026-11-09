const groupChat = 2
const groupAssistant = 7
const foldedGroupMask = 2
const mutedGroupMasks = new Set([2, 3, 4])

function orderedContacts(rows, order) {
  const byId = new Map(rows.map(row => [row.contactId, row]))
  const ordered = (order ?? []).map(id => byId.get(id)).filter(Boolean)
  return ordered.length === rows.length ? ordered : rows
}

// Called by the desktop Framework only for HNU's opt-in recent-contact request.
export async function readQQLayout(snapshot, { UserApi, GroupApi }) {
  const recent = orderedContacts(snapshot.changedList, snapshot.sortedContactList)
  const groups = await GroupApi.getGroups(true)
  const byGroup = new Map(groups.map(group => [String(group.groupCode), group]))
  const assistant = recent.find(row => row.chatType === groupAssistant)
  let folded = orderedContacts(assistant?.nestedChangedList ?? [], assistant?.nestedSortedContactList)
  if (!folded.length) {
    const peers = groups.filter(group => Number(group.cmdUinMsgMask) === foldedGroupMask)
      .map(group => ({ chatType: groupChat, peerUid: String(group.groupCode) }))
    if (peers.length) {
      const service = UserApi.context.session.getRecentContactService()
      const result = await service.getContacts(peers)
      if (result.result !== 0 || !Array.isArray(result.foundContacts)) throw new Error('无法读取 QQ 群助手')
      folded = result.foundContacts.sort((a, b) => Number(b.sortField) - Number(a.sortField))
    }
  }
  function chat(row, inGroupAssistant = false) {
    const mask = Number(byGroup.get(String(row.peerUin))?.cmdUinMsgMask)
    const unread = Number(row.unreadCnt)
    return {
      chatType: row.chatType, peerUin: row.peerUin, remark: row.remark, peerName: row.peerName,
      sendNickName: row.sendNickName, msgTime: row.msgTime,
      isTop: row.topFlag === 1, inGroupAssistant,
      isMuted: row.isMsgDisturb === true || inGroupAssistant || row.chatType === groupChat && mutedGroupMasks.has(mask),
      unreadCount: Number.isSafeInteger(unread) && unread >= 0 ? unread : null,
    }
  }
  return {
    conversations: [
      ...recent.filter(row => [1, groupChat, 100].includes(row.chatType)).map(row => chat(row)),
      ...folded.filter(row => row.chatType === groupChat).map(row => chat(row, true)),
    ],
    groups: groups.map(group => ({ group_id: String(group.groupCode), group_name: group.groupName })),
  }
}
