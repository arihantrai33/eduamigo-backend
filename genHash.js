const b=require('bcryptjs'); b.hash('Test@1234',10).then(h => { console.log(h); })
