(() => {
  const STORAGE_KEY = "userstore_inventory_v1";
  const $ = (id) => document.getElementById(id);
  const today = () => new Date().toISOString().slice(0, 10);
  const money = (value) => new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const escapeHtml = (str = "") => String(str).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  const statusLabels = { saved: "Saqlanmoqda", sale: "Sotuvda", sold: "Sotilgan" };
  const typeLabels = { ordinary: "Oddiy", collectible: "Collectible", account: "Akkaunt", other: "Boshqa" };
  const statusClass = { saved: "status-saved", sale: "status-sale", sold: "status-sold" };
  const typeClass = { ordinary: "type-ordinary", collectible: "type-collectible", account: "type-account", other: "type-other" };
  const seed = [
    {id:"demo1",username:"@sohjahon",type:"ordinary",status:"sold",buyPrice:50000,askPrice:150000,soldPrice:130000,soldDate:"2026-10-20",note:"Namuna yozuv — o'zgartir yoki o'chir.",createdAt:"2026-10-20T14:32:00.000Z"},
    {id:"demo2",username:"@uzb_cars",type:"collectible",status:"sale",buyPrice:0,askPrice:200000,soldPrice:0,soldDate:"",note:"",createdAt:"2026-10-19T10:00:00.000Z"},
    {id:"demo3",username:"@anime_uzb",type:"ordinary",status:"sale",buyPrice:20000,askPrice:100000,soldPrice:0,soldDate:"",note:"",createdAt:"2026-10-18T10:00:00.000Z"},
    {id:"demo4",username:"@crypto_trend",type:"ordinary",status:"sold",buyPrice:30000,askPrice:120000,soldPrice:110000,soldDate:"2026-10-18",note:"",createdAt:"2026-10-18T21:05:00.000Z"},
    {id:"demo5",username:"@iphone_shop",type:"collectible",status:"sale",buyPrice:100000,askPrice:350000,soldPrice:0,soldDate:"",note:"",createdAt:"2026-10-17T09:00:00.000Z"},
    {id:"demo6",username:"@game_accs",type:"account",status:"saved",buyPrice:0,askPrice:0,soldPrice:0,soldDate:"",note:"",createdAt:"2026-10-16T09:00:00.000Z"},
    {id:"demo7",username:"@free_premium",type:"ordinary",status:"sold",buyPrice:70000,askPrice:200000,soldPrice:180000,soldDate:"2026-10-15",note:"",createdAt:"2026-10-15T12:40:00.000Z"},
    {id:"demo8",username:"@sahzoda_01",type:"collectible",status:"sale",buyPrice:150000,askPrice:400000,soldPrice:0,soldDate:"",note:"",createdAt:"2026-10-14T11:00:00.000Z"}
  ];
  let items = loadItems();
  let selected = new Set();
  let activeView = "dashboard";

  function loadItems() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) return JSON.parse(raw);
      // First launch includes sample records so the dashboard doesn't look empty.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
      return seed.map(x => ({...x}));
    } catch (e) { return []; }
  }
  function saveItems() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); $("navCount").textContent = items.length; }
    catch (e) { toast("Saqlash amalga oshmadi. Brauzer xotirasi to'lgan bo'lishi mumkin.", "error"); }
  }
  function profit(item) { return item.status === "sold" ? (Number(item.soldPrice)||0) - (Number(item.buyPrice)||0) : 0; }
  function dateText(value) {
    if (!value) return "—";
    const d = new Date(value + (value.length === 10 ? "T00:00:00" : ""));
    return Number.isNaN(d.getTime()) ? escapeHtml(value) : d.toLocaleDateString("uz-UZ", {year:"numeric",month:"2-digit",day:"2-digit"});
  }
  function toast(message, type="success") {
    const node = document.createElement("div"); node.className = `toast ${type}`; node.textContent = message;
    $("toastContainer").appendChild(node); setTimeout(() => node.remove(), 3200);
  }
  function setView(view) {
    activeView = view;
    document.querySelectorAll(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
    document.querySelectorAll(".view").forEach(el => el.classList.toggle("active", el.id === `${view}View`));
    const titles = {
      dashboard:["Xush kelibsan! 👋","Barcha username va akkauntlaringni bir joyda boshqar."],
      inventory:["Usernamelar","Inventaringdagi barcha yozuvlar."],
      sold:["Sotilganlar","Yakunlangan savdolaring tarixi."],
      stats:["Statistika","Inventaring va moliyaviy natijalaring."],
      backup:["Zaxira / Tiklash","Ma'lumotlaringni xavfsiz saqla."]
    };
    $("pageTitle").textContent = titles[view][0]; $("pageSubtitle").textContent = titles[view][1];
    $("sidebar").classList.remove("open");
    if(view === "sold") renderSold();
    if(view === "stats") renderStats();
    if(view === "backup") $("navCount").textContent = items.length;
    if(view === "inventory") $("searchInput").focus({preventScroll:true});
  }
  function renderStats() {
    const sold = items.filter(x=>x.status==="sold"), sale = items.filter(x=>x.status==="sale");
    const totalProfit = sold.reduce((a,x)=>a+profit(x),0);
    $("totalCount").innerHTML = `${items.length} <small>ta</small>`;
    $("forSaleCount").innerHTML = `${sale.length} <small>ta</small>`;
    $("soldCount").innerHTML = `${sold.length} <small>ta</small>`;
    $("totalProfit").innerHTML = `${money(totalProfit)} <small>so'm</small>`;
    $("navCount").textContent = items.length;
    const statuses = [{key:"saved",label:"Saqlanmoqda",color:"#388dff"},{key:"sale",label:"Sotuvda",color:"#27e6a0"},{key:"sold",label:"Sotilgan",color:"#a56bff"}];
    $("statusBreakdown").innerHTML = statuses.map(s=>{
      const n=items.filter(x=>x.status===s.key).length, pct=items.length?n/items.length*100:0;
      return `<div class="breakdown-row"><span>${s.label}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${s.color}"></div></div><strong>${n}</strong></div>`;
    }).join("");
    const invested = items.reduce((a,x)=>a+(Number(x.buyPrice)||0),0);
    const revenue = sold.reduce((a,x)=>a+(Number(x.soldPrice)||0),0);
    const asking = sale.reduce((a,x)=>a+(Number(x.askPrice)||0),0);
    const lines = [["Jami xarid qiymati",invested],["Sotuvdagi so'ralgan narx",asking],["Sotuvdan tushgan mablag'",revenue],["Sof foyda / zarar",totalProfit]];
    $("financeBreakdown").innerHTML = lines.map(([l,v])=>`<div class="finance-row"><span>${l}</span><strong class="${v<0?'loss':''}">${money(v)} so'm</strong></div>`).join("");
    const recent=[...items].sort((a,b)=>(b.soldDate||b.createdAt||"").localeCompare(a.soldDate||a.createdAt||"")).slice(0,5);
    $("activityList").innerHTML = recent.length ? recent.map(x=>`<div class="activity-item"><span class="activity-dot"></span><div><strong>${escapeHtml(x.username)}</strong><p>${x.status==="sold"?"Sotuv yakunlandi":x.status==="sale"?"Sotuvga qo'yilgan":"Saqlanmoqda"}${x.status==="sold"?" • "+money(x.soldPrice)+" so'm":""}</p></div><time>${dateText(x.soldDate||String(x.createdAt||"").slice(0,10))}</time></div>`).join("") : `<p class="user-note">Hali faoliyat yo'q.</p>`;
  }
  function renderTable() {
    const query = ($("searchInput").value || $("globalSearch").value).trim().toLowerCase();
    const status = $("statusFilter").value, type = $("typeFilter").value;
    const filtered = items.filter(x => {
      const match = `${x.username} ${x.note||""}`.toLowerCase().includes(query);
      return match && (status==="all"||x.status===status) && (type==="all"||x.type===type);
    });
    $("itemsBody").innerHTML = filtered.map(x=>{
      const p=profit(x), sold = x.status==="sold";
      return `<tr>
        <td><input type="checkbox" class="row-check" data-id="${escapeHtml(x.id)}" ${selected.has(x.id)?"checked":""} aria-label="Tanlash"></td>
        <td><div class="user-cell"><div class="user-avatar">${escapeHtml((x.username.replace(/^@/,"")[0]||"?").toUpperCase())}</div><div><div class="user-name">${escapeHtml(x.username)}</div>${x.note?`<div class="user-note">${escapeHtml(x.note)}</div>`:""}</div></div></td>
        <td><span class="pill ${typeClass[x.type]||typeClass.other}">${typeLabels[x.type]||"Boshqa"}</span></td>
        <td><span class="pill ${statusClass[x.status]}">${statusLabels[x.status]}</span></td>
        <td><div class="money">${money(x.buyPrice)}</div><div class="money-sub">so'm</div></td>
        <td><div class="money">${money(x.askPrice)}</div><div class="money-sub">so'm</div></td>
        <td><div class="money">${sold?money(x.soldPrice):"—"}</div>${sold?`<div class="money-sub">so'm</div>`:""}</td>
        <td>${sold?`<span class="${p>=0?"profit":"loss"}">${p>0?"+":""}${money(p)}</span>`:"—"}</td>
        <td><div class="action-group">${x.status!=="sold"?`<button class="action-btn sell" data-action="sell" data-id="${escapeHtml(x.id)}" title="Sotildi deb belgilash">↗</button>`:`<button class="action-btn" data-action="view" data-id="${escapeHtml(x.id)}" title="Ko'rish">◉</button>`}<button class="action-btn" data-action="edit" data-id="${escapeHtml(x.id)}" title="Tahrirlash">✎</button><button class="action-btn delete" data-action="delete" data-id="${escapeHtml(x.id)}" title="O'chirish">⌫</button></div></td>
      </tr>`;
    }).join("");
    $("emptyState").classList.toggle("show", filtered.length===0);
    $("resultsCount").textContent = `${filtered.length} ta yozuv ko'rsatilmoqda`;
    $("selectAll").checked = filtered.length>0 && filtered.every(x=>selected.has(x.id));
    $("deleteSelected").disabled = selected.size===0;
    $("navCount").textContent = items.length;
    renderStats();
  }
  function renderSold() {
    const sold=items.filter(x=>x.status==="sold").sort((a,b)=>(b.soldDate||"").localeCompare(a.soldDate||""));
    const revenue=sold.reduce((a,x)=>a+(Number(x.soldPrice)||0),0), net=sold.reduce((a,x)=>a+profit(x),0);
    $("soldSummary").innerHTML = `<div class="summary-chip"><span>Yakunlangan savdolar</span><strong>${sold.length} ta</strong></div><div class="summary-chip"><span>Jami tushum</span><strong>${money(revenue)} so'm</strong></div><div class="summary-chip"><span>Sof foyda / zarar</span><strong class="${net<0?'loss':'profit'}">${net>0?"+":""}${money(net)} so'm</strong></div>`;
    $("soldBody").innerHTML = sold.map(x=>`<tr><td><div class="user-cell"><div class="user-avatar">${escapeHtml((x.username.replace(/^@/,"")[0]||"?").toUpperCase())}</div><div class="user-name">${escapeHtml(x.username)}</div></div></td><td>${dateText(x.soldDate)}</td><td>${money(x.buyPrice)} so'm</td><td>${money(x.soldPrice)} so'm</td><td><span class="${profit(x)>=0?'profit':'loss'}">${profit(x)>0?"+":""}${money(profit(x))} so'm</span></td><td><div class="action-group"><button class="action-btn" data-action="edit" data-id="${escapeHtml(x.id)}" title="Tahrirlash">✎</button><button class="action-btn delete" data-action="unsell" data-id="${escapeHtml(x.id)}" title="Sotuvni bekor qilish">↶</button></div></td></tr>`).join("");
    $("soldEmpty").classList.toggle("show",sold.length===0);
  }
  function renderAll(){renderTable();renderSold();renderStats();}
  function openEditor(item=null) {
    $("itemForm").reset(); $("itemId").value=item?.id||"";
    $("dialogTitle").textContent=item?"Username'ni tahrirlash":"Yangi username qo'shish";
    $("username").value=item?.username||""; $("itemType").value=item?.type||"ordinary"; $("itemStatus").value=item?.status||"sale";
    $("buyPrice").value=item?.buyPrice??0; $("askPrice").value=item?.askPrice??0; $("soldPrice").value=item?.soldPrice??0;
    $("soldDate").value=item?.soldDate||today(); $("itemNote").value=item?.note||"";
    updateSoldFields(); $("itemDialog").showModal();
  }
  function updateSoldFields(){const show=$("itemStatus").value==="sold";$("soldPriceWrap").style.display=show?"flex":"none";$("soldDateWrap").style.display=show?"flex":"none";}
  function openSell(item) {
    $("sellForm").reset();$("sellId").value=item.id;$("sellItemName").textContent=item.username;
    $("sellPrice").value=item.askPrice||"";$("sellDate").value=today();updateProfitPreview();$("sellDialog").showModal();
  }
  function updateProfitPreview(){const item=items.find(x=>x.id===$("sellId").value);if(!item)return;const p=(Number($("sellPrice").value)||0)-(Number(item.buyPrice)||0);$("profitPreview").textContent=`${p>=0?"Taxminiy foyda":"Taxminiy zarar"}: ${p>0?"+":""}${money(p)} so'm`;$("profitPreview").style.color=p>=0?"#53edb0":"#ff8396";}
  function act(action,id) {
    const item=items.find(x=>x.id===id);if(!item)return;
    if(action==="edit"||action==="view"){openEditor(item);return;}
    if(action==="sell"){openSell(item);return;}
    if(action==="delete"){if(confirm(`${item.username} yozuvini o'chirishni xohlaysanmi?`)){items=items.filter(x=>x.id!==id);selected.delete(id);saveItems();renderAll();toast("Yozuv o'chirildi.");}return;}
    if(action==="unsell"){if(confirm(`${item.username} sotuvini bekor qilamizmi?`)){item.status="sale";item.soldPrice=0;item.soldDate="";saveItems();renderAll();toast("Sotuv bekor qilindi.");}}
  }
  $("addBtn").addEventListener("click",()=>openEditor());$("emptyAddBtn").addEventListener("click",()=>openEditor());
  $("closeDialog").addEventListener("click",()=>$("itemDialog").close());$("cancelDialog").addEventListener("click",()=>$("itemDialog").close());
  $("closeSellDialog").addEventListener("click",()=>$("sellDialog").close());$("cancelSell").addEventListener("click",()=>$("sellDialog").close());
  $("itemStatus").addEventListener("change",updateSoldFields);
  $("itemForm").addEventListener("submit",e=>{
    e.preventDefault();const id=$("itemId").value,username=$("username").value.trim();if(!username){toast("Username yoki nomini kirit.", "error");return;}
    const old=items.find(x=>x.id===id);const status=$("itemStatus").value;
    const obj={id:id||`${Date.now()}-${Math.random().toString(16).slice(2,7)}`,username:username.startsWith("@")||username.includes(" ")?username:"@"+username,type:$("itemType").value,status,buyPrice:Math.max(0,Number($("buyPrice").value)||0),askPrice:Math.max(0,Number($("askPrice").value)||0),soldPrice:status==="sold"?Math.max(0,Number($("soldPrice").value)||0):0,soldDate:status==="sold"?($("soldDate").value||today()):"",note:$("itemNote").value.trim(),createdAt:old?.createdAt||new Date().toISOString()};
    if(status==="sold"&&!obj.soldPrice){if(!confirm("Sotilgan narxi 0 so'm. Shu holatda saqlaymizmi?"))return;}
    if(old)items=items.map(x=>x.id===id?obj:x);else items.unshift(obj);
    saveItems();renderAll();$("itemDialog").close();toast(old?"O'zgarishlar saqlandi.":"Yangi yozuv qo'shildi.");
  });
  $("sellPrice").addEventListener("input",updateProfitPreview);
  $("sellForm").addEventListener("submit",e=>{e.preventDefault();const item=items.find(x=>x.id===$("sellId").value);if(!item)return;item.status="sold";item.soldPrice=Math.max(0,Number($("sellPrice").value)||0);item.soldDate=$("sellDate").value||today();saveItems();renderAll();$("sellDialog").close();toast(`${item.username} sotilganlar ro'yxatiga qo'shildi.`);});
  $("itemsBody").addEventListener("click",e=>{const b=e.target.closest("[data-action]");if(b)act(b.dataset.action,b.dataset.id);});
  $("soldBody").addEventListener("click",e=>{const b=e.target.closest("[data-action]");if(b)act(b.dataset.action,b.dataset.id);});
  $("itemsBody").addEventListener("change",e=>{if(e.target.classList.contains("row-check")){const id=e.target.dataset.id;e.target.checked?selected.add(id):selected.delete(id);renderTable();}});
  $("selectAll").addEventListener("change",()=>{const query=($("searchInput").value||$("globalSearch").value).trim().toLowerCase();items.filter(x=>`${x.username} ${x.note||""}`.toLowerCase().includes(query)&&($("statusFilter").value==="all"||x.status===$("statusFilter").value)&&($("typeFilter").value==="all"||x.type===$("typeFilter").value)).forEach(x=>$("selectAll").checked?selected.add(x.id):selected.delete(x.id));renderTable();});
  $("deleteSelected").addEventListener("click",()=>{if(!selected.size)return;if(confirm(`${selected.size} ta yozuvni o'chirishni xohlaysanmi?`)){items=items.filter(x=>!selected.has(x.id));selected.clear();saveItems();renderAll();toast("Tanlangan yozuvlar o'chirildi.");}});
  ["searchInput","globalSearch","statusFilter","typeFilter"].forEach(id=>$(id).addEventListener("input",()=>{if(id==="globalSearch")$("searchInput").value=$("globalSearch").value;else if(id==="searchInput")$("globalSearch").value=$("searchInput").value;renderTable();}));
  $("clearFilters").addEventListener("click",()=>{$("searchInput").value="";$("globalSearch").value="";$("statusFilter").value="all";$("typeFilter").value="all";renderTable();});
  document.querySelectorAll(".nav-item").forEach(btn=>btn.addEventListener("click",()=>setView(btn.dataset.view)));
  $("mobileMenu").addEventListener("click",()=>$("sidebar").classList.toggle("open"));
  $("themeBtn").addEventListener("click",()=>{document.body.classList.toggle("light-mode");const light=document.body.classList.contains("light-mode");$("themeBtn").textContent=light?"☀":"☾";localStorage.setItem("userstore_theme",light?"light":"dark");});
  if(localStorage.getItem("userstore_theme")==="light"){document.body.classList.add("light-mode");$("themeBtn").textContent="☀";}
  document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();$("globalSearch").focus();}if(e.key==="Escape")$("sidebar").classList.remove("open");});
  $("exportBtn").addEventListener("click",()=>{const blob=new Blob([JSON.stringify({app:"UserStore",version:1,exportedAt:new Date().toISOString(),items},null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`userstore-backup-${today()}.json`;a.click();URL.revokeObjectURL(a.href);toast("Zaxira fayli yuklab olindi.");});
  $("importFile").addEventListener("change",async e=>{const file=e.target.files[0];if(!file)return;try{const parsed=JSON.parse(await file.text());const incoming=Array.isArray(parsed)?parsed:parsed.items;if(!Array.isArray(incoming)||incoming.some(x=>!x.username||!x.id))throw new Error("invalid");if(!confirm(`${incoming.length} ta yozuvni tiklaymizmi? Hozirgi ro'yxat almashtiriladi.`))return;items=incoming;selected.clear();saveItems();renderAll();toast("Zaxira muvaffaqiyatli tiklandi.");}catch(err){toast("Fayl noto'g'ri yoki buzilgan JSON.", "error");}finally{e.target.value="";}});
  $("resetBtn").addEventListener("click",()=>{if(confirm("Barcha yozuvlar butunlay o'chadi. Davom etasanmi?")&&confirm("Oxirgi tasdiq: oldin JSON zaxira oldingmi?")){items=[];selected.clear();saveItems();renderAll();toast("Inventar tozalandi.");}});
  renderAll();
})();
