const {getConnection}=require('../shared/db');
module.exports=async function(context){
 const pool=await getConnection();
 const result=await pool.request().query(`SELECT 
 (SELECT COUNT(*) FROM Companies) AS TotalAccounts,
 (SELECT COUNT(*) FROM Subscriptions) AS TotalSubscriptions,
 (SELECT COUNT(*) FROM (SELECT CompanyId FROM CompanySubscriptions GROUP BY CompanyId HAVING COUNT(*)>1) t) AS AccountsWithMultipleSubscriptions,
 (SELECT COUNT(*) FROM Subscriptions s LEFT JOIN CompanySubscriptions cs ON s.SubscriptionId=cs.SubscriptionId WHERE cs.SubscriptionId IS NULL) AS UnmappedSubscriptions`);
 context.res={body:result.recordset[0]};
};
