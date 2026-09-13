'use strict'

const $ = (id) => document.getElementById(id)
const state = { task: null, selected: null }
const text = (value, fallback = '') => typeof value === 'string' && value ? value : fallback
const safePrint = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2)
function feedback(message) { $('feedback').textContent = message }
async function refreshArchiveList(selectTaskId = state.task?.archive?.taskId) {
  try {
    const archives = await window.taskArchive.list(); const selector = $('archives')
    selector.replaceChildren(...[{ taskId: '', title: '选择已有档案' }, ...archives].map((entry) => {
      const option = document.createElement('option'); option.value = entry.taskId; option.textContent = entry.taskId ? `${entry.title || '未命名任务'} · ${entry.taskId.slice(0, 8)}` : entry.title; return option
    }))
    selector.value = selectTaskId || ''
  } catch { $('archives').replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: '无法读取已有档案' })) }
}
function sessions() { return $('sessions').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }
function metadata() {
  const value = $('adapter').value.trim()
  let adapter
  if (value) { try { adapter = JSON.parse(value) } catch { throw new Error('字段映射必须是 JSON') } }
  return { title: $('title').value, goal: $('goal').value, constraints: $('constraints').value, sessions: sessions(), adapter }
}
function statusLabel(item) { return item.state === 'invalid' ? '数据异常' : item.status === 'legacy_succeeded' ? '已记录成功，待验收' : item.status || '待核验' }
function priority(item) { return item.state !== 'ready' || ['failed', 'needs_review', 'unknown'].includes(item.status) }
function render(view) {
  state.task = view; state.selected = null
  refreshArchiveList(view.archive.taskId)
  $('summary').hidden = false; $('items-section').hidden = false; $('detail-section').hidden = true; $('save').disabled = false; $('retry').disabled = false
  $('title').value = text(view.archive.title); $('goal').value = text(view.archive.goal); $('constraints').value = text(view.archive.constraints); $('sessions').value = (view.archive.sessions || []).join('\n'); $('adapter').value = safePrint(view.archive.adapter)
  $('task-name').textContent = view.archive.title || `任务 ${view.archive.taskId}`
  $('source').textContent = `${view.manifest.format} · ${view.manifest.itemCount} 项 · ${view.manifest.sha256.slice(0, 12)}`
  const counts = { total:view.items.length, failed:0, review:0, locked:0, invalid:0 }
  for (const item of view.items) { if (item.status === 'failed') counts.failed += 1; if (item.state !== 'ready' || item.status === 'needs_review' || item.status === 'unknown') counts.review += 1; if (item.acceptance?.valid) counts.locked += 1; if (item.state === 'invalid') counts.invalid += 1 }
  const cards = [['总项',counts.total,false],['失败',counts.failed,counts.failed>0],['待核验',counts.review,counts.review>0],['已锁定',counts.locked,false],['数据异常',counts.invalid,counts.invalid>0]]
  $('stats').replaceChildren(...cards.map(([label,value,alert]) => { const node=document.createElement('span'); node.className=`stat${alert?' alert':''}`; node.textContent=`${label} ${value}`; return node }))
  const ordered = [...view.items].sort((a,b) => Number(priority(b)) - Number(priority(a)) || a.row - b.row)
  $('items').replaceChildren(...ordered.map((item) => { const button=document.createElement('button'); button.className='item'; button.dataset.priority=String(priority(item)); button.append(Object.assign(document.createElement('span'),{textContent:item.itemId || `第 ${item.row} 行`}),Object.assign(document.createElement('span'),{textContent:statusLabel(item)}),Object.assign(document.createElement('small'),{textContent:item.acceptance?.valid?'已锁定':item.problem || item.error || item.nextAction || '查看'})); button.addEventListener('click',()=>inspect(item)); return button }))
}
async function inspect(listItem) {
  if (!state.task) return
  feedback('读取条目详情…')
  try {
    const detail = await window.taskArchive.inspect(state.task.archive.taskId, listItem.itemId)
    state.selected = { ...detail.item, manifestSha256: state.task.manifest.sha256, artifactSha256: detail.artifact?.sha256 }
    $('detail-section').hidden=false; $('detail-title').textContent=`${detail.item.itemId || `第 ${detail.item.row} 行`} · ${statusLabel(detail.item)}`
    $('detail-status').textContent=detail.item.acceptance?.valid ? '当前验收锁定有效。' : detail.item.acceptance?.warning || detail.item.problem || detail.item.error || detail.item.nextAction || ''
    $('artifact').textContent=detail.artifact ? `${detail.artifact.name || '产物不可用'}\n${detail.artifact.preview || detail.artifact.message || ''}` : '未提供产物'
    const image = $('artifact-image'); image.hidden = !detail.artifact?.imageDataUrl; image.removeAttribute('src'); if (detail.artifact?.imageDataUrl) image.src = detail.artifact.imageDataUrl
    $('evidence').textContent=safePrint(detail.item.evidence) || '未提供证据'
    $('diff').textContent=safePrint(detail.item.diff) || '未提供差异'
    $('accept').disabled=!(detail.item.state === 'ready' && detail.item.status === 'succeeded' && detail.item.artifactPath && detail.artifact && !detail.artifact.unavailable)
    feedback('')
  } catch (error) { feedback(`无法读取条目：${error.message}`) }
}
$('open').addEventListener('click', async () => { const taskId = $('archives').value; if (!taskId) return feedback('请选择已有档案。'); try { render(await window.taskArchive.read(taskId)); feedback('已从当前原始清单刷新档案。') } catch (error) { feedback(`无法打开档案：${error.message}`) } })
$('bind').addEventListener('click', async () => { feedback('等待选择原始 JSON 或 CSV 清单…'); try { const view=await window.taskArchive.bind(metadata()); if (view) { render(view); feedback('已绑定。字段映射和原始清单保持不改写。') } else feedback('已取消选择。') } catch (error) { feedback(`绑定失败：${error.message}`) } })
$('save').addEventListener('click', async () => { if (!state.task) return; try { render(await window.taskArchive.checkpoint(state.task.archive.taskId, state.task.archive.revision, metadata())); feedback('任务说明已保存。') } catch (error) { feedback(`保存失败：${error.message}`) } })
$('retry').addEventListener('click', async () => { if (!state.task) return; try { const request=await window.taskArchive.retryPlan(state.task.archive.taskId); feedback(`已生成不可变重跑计划：${request.itemIds.length} 个失败项；未执行任何任务。`) } catch (error) { feedback(`生成计划失败：${error.message}`) } })
$('accept').addEventListener('click', async () => { if (!state.task || !state.selected) return; try { render(await window.taskArchive.accept(state.task.archive.taskId, state.selected.itemId, state.selected.sourceSha256, state.selected.manifestSha256, state.selected.artifactSha256)); feedback('验收已锁定；源行或产物变更会自动失效。') } catch (error) { feedback(`验收失败：${error.message}`) } })
refreshArchiveList()
