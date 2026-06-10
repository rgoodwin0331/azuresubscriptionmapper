const {getConnection}=require('../shared/db');
module.exports=async function(context,req){
 const {q='',type='company'}=req.query;
 const pool=await getConnection();
 let result;
 if(type==='company'){
  result=await pool.request().input('q',`%${q}%`).query(`SELECT c.CompanyName,COUNT(cs.SubscriptionId) AS SubscriptionCount FROM Companies c LEFT JOIN CompanySubscriptions cs ON c.CompanyId=cs.CompanyId WHERE c.CompanyName LIKE @q GROUP BY c.CompanyName`);
 } else {
  result=await pool.request().input('q',`%${q}%`).query(`SELECT s.SubscriptionName,c.CompanyName FROM Subscriptions s LEFT JOIN CompanySubscriptions cs ON s.SubscriptionId=cs.SubscriptionId LEFT JOIN Companies c ON cs.CompanyId=c.CompanyId WHERE s.SubscriptionName LIKE @q`);
 }
 context.res={body:result.recordset};
};
