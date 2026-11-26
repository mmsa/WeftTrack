const f=window.fixture;
const select=id=>document.getElementById(id);
for(const [id,text] of Object.entries({key:f.key,"task-title":f.title,review:f.repository+" · PR #"+f.pr,branch:f.branch,target:f.target,short:f.published.slice(0,12)})) select(id).textContent=text;
select("open-site").href="./sites/"+f.repository+"/staging/"+f.published+"/";
function showPhase(phase){
  const published=phase==="published";
  document.querySelector(".receipt").classList.toggle("live",published);
  select("status").textContent=published?"Published to staging":"Merged · Awaiting staging";
  select("explanation").textContent=published?"Staging contains the reviewed change. Open the site to inspect the exact snapshot recorded below.":"WeftGit recorded the merge into "+f.target+". The staging publication had yet to happen.";
  select("published").hidden=!published;
  const entries=[["Reviewed commit",f.reviewed],["Merged commit",f.merge]];
  if(published) entries.push(["Published commit",f.published],["Published at",f.when+" UTC"]);
  select("details").replaceChildren(...entries.map(([label,value])=>{const row=document.createElement("div"),dt=document.createElement("dt"),dd=document.createElement("dd"),code=document.createElement("code");dt.textContent=label;code.textContent=value;dd.append(code);row.append(dt,dd);return row;}));
}
for(const radio of document.querySelectorAll("input[name=phase]")) radio.onchange=()=>showPhase(radio.value);
showPhase(document.querySelector("input[name=phase]:checked").value);
