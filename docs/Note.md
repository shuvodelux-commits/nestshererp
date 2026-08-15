Daybook Module missing. DayBook actualy show all transaction happend in day. Date start end picker to show what date to what date view. Also all transaction edit/update/delete from here possible so don't need to go different module to edit. At the day end we review all from here and also print a file so that we also have a phisycal copy from here. In this physical copy all transaction before and after also mention in final print file. 

1. Add an internal double-entry journal_entry / journal_line backbone. UI keeps showing simple ledgers. No new user-facing requirement, huge integrity gain. RECOMMENDED. Agreed with you.

2. In Offline system browser cheched in browser database. Offlin system only one user can write.so single-writer rule. User setting to select which device can write. Mainly this feature only for one device users who use only one device to do all transaction. Like a single shop sells through 1 laptop. in the end he connect internet to sync. And full offline standalon desktop is later, now only focused online system with browser based system to run business without internet for temprery period because in bangladesh internet system and electricity not stabel. is offline based system work on android tablet or phone on browser ?

3. Duplicate phone number allowed but same number with only customer because in pos we have a system to search invoice by phone so if in customer module same number linked to more customer then this function not work. So same number with one customer. supplier, expense, vendor possible because one party can be customer,supplier,expense, vendor.

4. If Invoice is deleted then all transaction is reversed. like stock,due,expense all transaction. Also we have draft invoice feature. We need a system to templete invoice system so we reuse and modified to use for same type of sells.

5. Add an internal party system but In UI show customer ledger, supplier ledger, vendor ledger and expense ledger. But a role attached. But we need to sell to supplier, or vendor or expensey then need a system to explecitly select that and all transaction in show in this party ledger. Example: when we sell to a supplier then this supplier show on customer ledger and supplier ledger also. and show full purchased and sell history from selected party ledger. 

6. In inventory has two system one for valuation one for sells. So Physical stock কোন lot থেকে বের হবে?
        ↓
FIFO / অন্য issue strategy
and 
Profit হিসাব করার সময় cost কত ধরা হবে?
        ↓
Valuation method
7. For nagetive stock products sells. Profit calculation method is last product price in that time after the product come in stock then show actual cost otherwise show cost using negetive stock product last price for calculation. 
8. I know Backdated Purchase is dengerus but for our country situaction it need. I know profit calculation effect that but after user can edit purchased then re-costing all calculation.
পুরনো transaction edit
       ↓
System সামনে থেকে হিসাব পুনরায় calculate করবে
       ↓
যে period close হয়ে গেছে
       ↓
সেটা আর silently পরিবর্তন করবে না
9. Period lock idea is good. If January
🔒 CLOSED then if anyone in February month go to edit January purchase then do not change silently change January Profit
January Stock
January COGS. Only person with permisson then Unlock
↓
Edit
↓
Audit Log

9. Minimal Vat, tax system implement.

10. Warehouse/ location system trun on but if one inventory then no need to create warehouse work as default warehouse.
11. Carton এবং Piece this is important nice feature. we can purchase in cartoon and pices system and sells on two system. So when we purchased then we select curtoon then a curtoon how much pcs enterd. In our shop we sell pipe in feet and pcs also. A pipe is 20 feet so its good if we manully create this unit.
12. 
