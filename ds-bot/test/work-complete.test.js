import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { savedTeam } from './team-state.js'
import { afterRound } from './relay-rows.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { scopeTarget } from '@deepseek-ai/dsh-scope'

let rt

// Chief, the admin of group 'r1', speaks there from 'ga'; Writer from 'gb'; Tester from 'gc'.
const seed = (room = {}, extraRooms = {}, bots = {}, top = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ...bots.a },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, ...bots.b },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3, ...bots.c },
    ...(bots.d ? { d: { id: 'd', name: 'Reviewer', role: 'Review', sessionId: 'd', createdAt: 4, ...bots.d } } : {}),
  },
  rooms: { r1: { id: 'r1', name: 'Ops', taskManagementEnabled: false, members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {}, ...room }, ...extraRooms },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
  ...top,
})

async function start(t, room, services, extraRooms, bots, llm, top, files = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room, extraRooms, bots, top)))
  for (const [name, value] of Object.entries(files)) writeFileSync(join(home, name), JSON.stringify(value))
  const selected = []
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => message => { calls.push(message); list.push(message) }
      agents.set(sessionId, { session: { id: sessionId, requestHeader: () => undefined }, calls, cancelled, inbox, followup: keep(held), steer: keep(nextStep), inject(message) { calls.push(message) }, async whenIdle() {}, cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: llm ?? { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'bg-' + (agents.size + 1) }), page: async () => ({ records: [], hasMore: false }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async (request) => { selected.push(request) } },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(agentOf(id).session, { type, seq: ++seq, data })
    }
  }
  const emitScoped = (parentId, name, info) => {
    const carrier = scopeTarget({}, agentOf(parentId))
    for (const listener of ctx.listeners.get(name) ?? []) listener.call(carrier, info)
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  // A Session takes up the newest message it was sent, as a new turn.
  const begin = (sessionId, message = agentOf(sessionId).calls.at(-1)) => {
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  // The user's message in the group, or a Bot's post the group Session took up, and the
  // round it starts.
  const round = (callId, message, sessionId = 'r1') => {
    emit(sessionId, 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, sessionId, { agent: { id: sessionId, inbox: agentOf(sessionId).inbox }, callId, signal: stop.signal }).then(async (value) => { result = await afterRound(rt, sessionId, value) })
    const read = () => result
    read.cancel = () => { stop.abort(); rt.stopRoomRound(rt.roomOf(sessionId)?.id ?? sessionId) }
    return read
  }
  const say = (text, taskId) => ({ content: [{ type: 'text', text }], source: { kind: 'user', ...(taskId && { taskId }) } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  await tool('list_bots', {}, 'a')
  return { home, ctx, agentOf, emit, emitScoped, tool, call, begin, finish, round, say, takePost, selected }
}

// The save before a group post runs on a timer; waiting with setImmediate starves it.
const until = async (check, ms = 3000) => {
  const stop = Date.now() + ms
  while (!check() && Date.now() < stop) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')




const delegatedId = value => /work_id: ([\w-]+)/.exec(value)[1]
async function formal(t) {
  const host = await start(t, { taskManagementEnabled: true, notice: '', members:['a','b','c','d'], sessions:{a:'ga',b:'gb',c:'gc',d:'gd'} }, undefined, undefined, { d:{} })
  const ended = host.round('intake', host.say('Compare two release notes'))
  await until(() => ended() !== undefined)
  host.begin('ga')
  const project = args => host.tool('project_task', args, 'ga').then(JSON.parse)
  const nodes = ['b','d','c'].map((ownerId,i) => ({ title:['Compare','Review','Verify'][i],ownerId,instructions:'Compare supplied text',deliverable:'Evidence',acceptance:'Differences explained',dependsOn:i?[1]:[] }))
  const card = await project({action:'plan',version:1,title:'Compare notes',acceptance:'Differences explained',nodes})
  const dispatch = await project({action:'dispatch',taskId:card.taskId,version:1,node:1})
  const args = {to:'Writer',goal:'Execute saved node',taskId:card.taskId,card_round:dispatch.dispatchRound,request_id:'formal'}
  await host.tool('delegate_work',args,'ga')
  return {host,card,dispatch,args}
}

test('formal project dispatch opens one protocol work; ask/answer/result keep its card and round', async t => {
  const {host,card,dispatch,args} = await formal(t)
  const source = host.begin('gb').source
  assert.equal(source.taskId,card.taskId)
  assert.equal(source.exchangeId,rt.state.rooms.r1.projectCards[card.taskId].rounds[dispatch.dispatchRound-1].dispatchId)
  assert.equal(source.workProtocol,true)
  const id = source.exchangeId
  assert.equal(rt.state.works[id].dispatchId,id)
  await host.tool('delegate_work',args,'ga')
  assert.equal(Object.values(rt.state.works).filter(w=>w.protocol).length,1)
  await host.tool('ask_back',{question:'Which baseline?'},'gb')
  assert.equal(rt.state.works[id].state,'need_input')
  host.finish('gb','Waiting for baseline')
  const question=host.begin('ga')
  assert.equal(question.source.parentExchangeId,id)
  await host.tool('answer_work',{work_id:rt.state.works[id].ref,answer:'Use note A'},'ga')
  const answer=host.begin('gb')
  assert.equal(answer.source.taskId,card.taskId)
  assert.equal(answer.source.exchangeId,id)
  host.finish('gb','Note B adds two changes.')
  await until(()=>host.agentOf('ga').calls.some(m=>m.source.replyTo===id))
  const reply=host.agentOf('ga').calls.find(m=>m.source.replyTo===id)
  assert.equal(reply.source.taskId,card.taskId)
  assert.equal(reply.source.parentExchangeId,id)
  assert.equal(rt.state.works[id],undefined)
  assert.equal(rt.state.rooms.r1.projectCards[card.taskId].acceptedAt,undefined)
  assert.equal(rt.state.rooms.r1.projectCards[card.taskId].rounds[0].result,undefined)
})

test('busy now creates an independent thread; queue preserves foreground and manual conversations', async t => {
  const host=await start(t)
  host.begin('b',host.say('User foreground'))
  const first=delegatedId(await host.tool('delegate_work',{to:'Writer',goal:'Background analysis'},'a'))
  const bg=rt.state.works[first].toSession
  assert.notEqual(bg,'b')
  assert.equal(rt.state.bots.b.sessionId,'b')
  assert.equal(rt.state.bots.b.openParts[0].sessionId,bg)
  assert.equal(rt.live.get('b').turn,1)
  host.begin(bg)
  await host.tool('ask_back',{question:'Which source?'},bg)
  host.finish(bg,'Waiting')
  host.begin('a')
  await host.tool('answer_work',{answer:'Source A'},'a')
  assert.equal(host.agentOf(bg).calls.at(-1).source.exchangeId,first)
  assert.equal(host.agentOf('b').calls.length,0)
  const second=delegatedId(await host.tool('delegate_work',{to:'Writer',goal:'After foreground',when:'queue'},'c'))
  assert.equal(rt.state.works[second].toSession,'b')
  assert.equal(host.agentOf('b').inbox.nextStep.length,0)
  assert.equal(host.agentOf('b').inbox.nextTurn[0].source.exchangeId,second)
})

test('silent note during an active turn waits for idle and survives in SQLite without waking it', async t => {
  const host=await start(t)
  host.begin('b',host.say('Working'))
  await host.tool('note_bot',{to:'Writer',note:'Fact for later'},'a')
  assert.equal(host.agentOf('b').calls.length,0)
  assert.equal(host.agentOf('b').inbox.nextStep.length,0)
  assert.equal(rt.state.silentNotes.b.length,1)
  await rt.save({required:true})
  assert.equal(savedTeam(host.home).silentNotes.b[0].message.source.silent,true)
  host.finish('b','User result')
  await until(()=>host.agentOf('b').calls.length===1)
  assert.equal(host.agentOf('b').calls[0].source.silent,true)
  assert.equal(host.agentOf('b').inbox.nextTurn.length,0)
  assert.equal(Object.keys(rt.state.works??{}).length,0)
})

test('repeated clarification pauses durably, explicit Continue releases one question, cancel suppresses late completion',async t=>{
  const host=await start(t)
  const id=delegatedId(await host.tool('delegate_work',{to:'Writer',goal:'Compare notes'},'a'))
  host.begin('b')
  await host.tool('ask_back',{question:'First?'},'b')
  host.finish('b','Wait')
  host.begin('a')
  await host.tool('answer_work',{answer:'A'},'a')
  host.begin('b')
  await host.tool('ask_back',{question:'Second?'},'b')
  assert.equal(rt.state.works[id].state,'paused')
  host.finish('b','Wait')
  const before=host.agentOf('a').calls.length
  await host.call('resume-work',{id})
  assert.equal(rt.state.works[id].state,'need_input')
  assert.equal(host.agentOf('a').calls.length,before+1)
  const again=await host.call('resume-work',{id})
  assert.equal(again.ok,false)
  await host.call('cancel-work',{id})
  assert.equal(rt.state.works[id],undefined)
  assert.equal(rt.state.works['closed:'+id].protocolReceipt.status,'cancelled')
  host.finish('b','Late answer')
  assert.equal(host.agentOf('a').calls.length,before+1)
})

test('active work inflight persists protocol, parent dispatch and original part',async t=>{
  const host=await start(t)
  const id=delegatedId(await host.tool('delegate_work',{to:'Writer',goal:'Auxiliary work'},'a'))
  const original=host.agentOf('b').calls.at(-1)
  const incoming={...original,source:{...original.source,parentExchangeId:'original-dispatch'}}
  host.begin('b',incoming)
  let trigger
  await until(()=>{try{trigger=JSON.parse(readFileSync(join(host.home,'inflight.json'),'utf8')).turns.b.trigger;return trigger?.exchangeId===id}catch{return false}})
  assert.equal(trigger.workProtocol,true)
  assert.equal(trigger.parentExchangeId,'original-dispatch')
  assert.equal(trigger.senderPart,'a')
})

test('two formal cards for one Bot execute in separate threads, answer their own questions and submit only their saved rounds', async t => {
  const {host,card:first} = await formal(t)
  const incoming1=host.begin('gb')
  await host.tool('project_task',{action:'start',taskId:first.taskId,round:1},'gb')
  await host.tool('ask_back',{question:'Baseline for first card?'},'gb')
  host.finish('gb','Waiting for first baseline')
  // A pending delegated work owns its original thread even while waiting, so a
  // second formal card gets a new thread and never reads the first card history.
  host.finish('ga','First card dispatched')
  const done=host.round('second-intake',host.say('Compare a separate set of release notes'))
  await until(()=>done()!==undefined)
  host.begin('ga')
  const nodes=['b','d','c'].map((ownerId,i)=>({title:['Compare second','Review second','Verify second'][i],ownerId,instructions:'Compare other text',deliverable:'Second evidence',acceptance:'Explain second differences',dependsOn:i?[1]:[]}))
  const second=JSON.parse(await host.tool('project_task',{action:'plan',version:1,title:'Second notes',acceptance:'Explain second differences',nodes},'ga'))
  const d2=JSON.parse(await host.tool('project_task',{action:'dispatch',taskId:second.taskId,version:1,node:1},'ga'))
  await host.tool('delegate_work',{to:'Writer',goal:'Execute second card',taskId:second.taskId,card_round:d2.dispatchRound,request_id:'second-card'},'ga')
  const work2=Object.values(rt.state.works).find(work=>work.protocol&&work.taskId===second.taskId)
  assert.notEqual(work2.toSession,'gb')
  const incoming2=host.begin(work2.toSession)
  await host.tool('project_task',{action:'start',taskId:second.taskId,round:d2.dispatchRound},work2.toSession)
  await host.tool('ask_back',{question:'Baseline for second card?'},work2.toSession)
  host.finish(work2.toSession,'Waiting for second baseline')
  host.finish('ga','Two questions waiting')
  host.begin('ga')
  await assert.rejects(host.tool('answer_work',{work_id:incoming1.source.exchangeId,answer:'Wrong-card answer'},'ga'),/another project card/)
  await host.call('answer-work',{id:incoming1.source.exchangeId,answer:'First baseline only'})
  await host.call('answer-work',{id:incoming2.source.exchangeId,answer:'Second baseline only'})
  const answer1=host.begin('gb')
  const answer2=host.begin(work2.toSession)
  assert.equal(answer1.source.taskId,first.taskId)
  assert.equal(answer2.source.taskId,second.taskId)
  assert.match(text(answer1),/First baseline only/)
  assert.doesNotMatch(text(answer1),/Second baseline only/)
  assert.match(text(answer2),/Second baseline only/)
  const all=[incoming1,answer1,incoming2,answer2].map(message=>({role:'user',...message}))
  const {scopedModelInput}=await import('../src/host/project-execution.js')
  const model1=await scopedModelInput(rt,'gb',all,rt.live.get('gb'))
  const model2=await scopedModelInput(rt,work2.toSession,all,rt.live.get(work2.toSession))
  assert.ok(model1.every(message=>message.source.taskId===first.taskId))
  assert.ok(model2.every(message=>message.source.taskId===second.taskId))
  await host.tool('project_task',{action:'submit',taskId:first.taskId,round:1,result:'First evidence'},'gb')
  await host.tool('project_task',{action:'submit',taskId:second.taskId,round:d2.dispatchRound,result:'Second evidence'},work2.toSession)
  host.finish('gb','First evidence ready')
  host.finish(work2.toSession,'Second evidence ready')
  await until(()=>!rt.state.works[incoming1.source.exchangeId]&&!rt.state.works[incoming2.source.exchangeId]&&!Object.keys(rt.state.workOutbox??{}).length)
  const cards=rt.state.rooms.r1.projectCards
  assert.equal(cards[first.taskId].rounds[0].result,'First evidence')
  assert.equal(cards[second.taskId].rounds[0].result,'Second evidence')
  assert.equal(cards[first.taskId].acceptedAt,undefined)
  assert.equal(cards[second.taskId].acceptedAt,undefined)
  assert.equal(rt.state.bots.b.sessionId,'b')
})

test('cancelling formal work rejects a late project submit and leaves a separate conversation running',async t=>{
  const {host,card}=await formal(t)
  const incoming=host.begin('gb')
  await host.tool('project_task',{action:'start',taskId:card.taskId,round:1},'gb')
  host.begin('b',host.say('An unrelated private conversation'))
  const result=await host.call('cancel-work',{id:incoming.source.exchangeId})
  assert.equal(result.ok,true)
  assert.equal(rt.live.get('b').turn,1)
  assert.equal(host.agentOf('b').cancelled.length,0)
  await assert.rejects(host.tool('project_task',{action:'submit',taskId:card.taskId,round:1,result:'Late result'},'gb'),/cancelled/)
  assert.equal(rt.state.rooms.r1.projectCards[card.taskId].rounds[0].result,undefined)
})

test('a three-Bot automatic ring pauses even with different text; metadata tools cannot reset it',async t=>{
  const host=await start(t)
  const done=host.round('ring',host.say('@Chief Compare the records'))
  await until(()=>host.agentOf('ga').calls.length===1)
  host.begin('ga');host.finish('ga','@Writer Explain field A')
  await until(()=>host.agentOf('gb').calls.length===1)
  host.begin('gb')
  host.emit('gb','tool/call',{callId:'meta',name:'bot_remember',arguments:'{}'})
  host.emit('gb','tool/result',{callId:'meta'})
  host.finish('gb','@Tester Describe field B with different words')
  await until(()=>host.agentOf('gc').calls.length===1)
  host.begin('gc');host.finish('gc','@Chief Consider field C from another angle')
  await until(()=>done()!==undefined)
  assert.equal(rt.state.rooms.r1.idlePaused.from,'c')
  assert.equal(rt.state.rooms.r1.paused[0].id,'a')
  assert.equal(host.agentOf('ga').calls.length,1,'the zero-tool ring cannot wake Chief again')
  const result=await host.call('resume-room-pause',{roomId:'r1'})
  assert.equal(result.ok,true)
  assert.equal(rt.state.rooms.r1.idlePaused,undefined)
  assert.equal(rt.state.rooms.r1.paused[0].idle,false,'the original parked call is released, not replaced by a new user task')
  const duplicate=await host.call('resume-room-pause',{roomId:'r1'})
  assert.equal(duplicate.value,false)
})

test('real work breaks the ring and normal useful group answers finish without a pause',async t=>{
  const host=await start(t)
  const done=host.round('work-ring',host.say('@Chief Compare records'))
  await until(()=>host.agentOf('ga').calls.length===1)
  host.begin('ga');host.finish('ga','@Writer Inspect field A')
  await until(()=>host.agentOf('gb').calls.length===1)
  host.begin('gb')
  host.emit('gb','tool/call',{callId:'read',name:'read',arguments:'{}'})
  host.emit('gb','tool/result',{callId:'read'})
  host.finish('gb','@Tester Field A was checked against the file; compare B')
  await until(()=>host.agentOf('gc').calls.length===1)
  host.begin('gc');host.finish('gc','@Chief The fields differ in their units')
  await until(()=>host.agentOf('ga').calls.length===2)
  host.begin('ga');host.finish('ga','The documented units explain the difference.')
  await until(()=>done()!==undefined)
  assert.equal(rt.state.rooms.r1.idlePaused,undefined)
})

test('formal work keeps the same dispatch after its group member session rolls over',async t=>{
  const {host,card}=await formal(t)
  const original=host.begin('gb')
  await host.tool('project_task',{action:'start',taskId:card.taskId,round:1},'gb')
  await host.tool('ask_back',{question:'Original input?'},'gb')
  host.finish('gb','Waiting')
  const room=rt.state.rooms.r1
  room.segments={b:[{sessionId:'gb',endedAt:Date.now()}]}
  room.sessions.b='gb-next'
  rt.advanceProtocolPart('gb','gb-next')
  rt.indexSessions()
  await rt.save({required:true})
  assert.equal(room.projectCards[card.taskId].rounds[0].executionSession,'gb-next')
  assert.equal(room.projectCards[card.taskId].rounds[0].planNode.session,'gb-next')
  await host.call('answer-work',{id:original.source.exchangeId,answer:'Same original input'})
  const source=host.begin('gb-next').source
  assert.equal(source.exchangeId,original.source.exchangeId)
  assert.equal(source.taskId,card.taskId)
  await host.tool('project_task',{action:'submit',taskId:card.taskId,round:1,result:'Rollover evidence'},'gb-next')
  assert.equal(room.projectCards[card.taskId].rounds[0].result,'Rollover evidence')
})

test('a formal owner can submit after a child result resumes its work; the child cannot submit that owner round',async t=>{
  const {host,card}=await formal(t)
  const original=host.begin('gb')
  await host.tool('project_task',{action:'start',taskId:card.taskId,round:1},'gb')
  const child=delegatedId(await host.tool('delegate_work',{to:'Tester',goal:'Check one comparison detail'},'gb'))
  host.finish('gb','Waiting for the detail check')
  host.begin('gc')
  await assert.rejects(host.tool('project_task',{action:'submit',taskId:card.taskId,round:1,result:'Child cannot own this round'},'gc'),/owner in the dispatched execution/)
  host.finish('gc','The detail was checked against the supplied records.')
  await until(()=>host.agentOf('gb').calls.some(message=>message.source.replyTo===child))
  const returned=host.begin('gb')
  assert.equal(returned.source.work,original.source.exchangeId)
  assert.notEqual(returned.source.exchangeId,original.source.exchangeId)
  assert.equal(returned.source.parentExchangeId,original.source.exchangeId)
  assert.equal(returned.source.workProtocol,true)
  await host.tool('project_task',{action:'submit',taskId:card.taskId,round:1,result:'Parent evidence includes the checked detail'},'gb')
  host.finish('gb','Final comparison with the checked detail.')
  await until(()=>!rt.state.works[original.source.exchangeId]&&!Object.keys(rt.state.workOutbox??{}).length)
  assert.equal(rt.state.rooms.r1.projectCards[card.taskId].rounds[0].result,'Parent evidence includes the checked detail')
  assert.equal(rt.state.rooms.r1.projectCards[card.taskId].acceptedAt,undefined)
})
