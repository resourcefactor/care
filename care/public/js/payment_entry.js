frappe.ui.form.on('Payment Entry', {
    setup: function(frm){
        if(frm.doc.__islocal){
            frm.set_value("custom_series", null)
        }
    },
    validate: function(frm){
        frm.trigger('set_cost_center')
    },
    party: function(frm){
        var filters = {}
        frappe.run_serially([
            () => frm.events.get_outstanding_documents(frm, filters),
            () => frm.trigger('set_cost_center')
        ])
    },
    mode_of_payment: function(frm){
        if(frm.doc.mode_of_payment && !frm.doc.cost_center) {
            frappe.call({
				method: "frappe.client.get",
				args: {
					doctype: "Mode of Payment",
					filters: { "name": frm.doc.mode_of_payment }
				},
				callback: function (r) {
				    r.message.accounts.forEach((d) => {
				        if (frm.doc.company == d.company){
				            frm.set_value("cost_center", d.cost_center)
				        }
				    })
				}
			})
		}
    },
    set_cost_center: function(frm){
        if(frm.doc.references){
            let grand_total = 0
            let out_total = 0
            for (var row of frm.doc.references) {
                if (row.reference_doctype == "Purchase Invoice" || row.reference_doctype == "Sales Invoice") {
                    if (row.reference_doctype == "Purchase Invoice") {
                        var doctype = "Purchase Invoice";
                        var fieldname = "cost_center"
                    }
                    else if (row.reference_doctype == "Sales Invoice") {
                        var doctype = "Sales Invoice";
                        var fieldname = "cost_center";
                    }
                    grand_total += row.total_amount
                    out_total += row.outstanding_amount
                    get_sales_order(row, doctype, fieldname);
                }
            }

        }
    }
});

frappe.ui.form.on('Payment Entry Reference', {
    references_remove: function(frm, cdt, cdn){
        let grand_total = 0
        let out_total = 0
        $.each(frm.doc['references'] || [], function(i, row) {
            grand_total += row.total_amount
            out_total += row.outstanding_amount
        });
        frm.set_value('grand_total', grand_total);
        frm.set_value('total_outstanding', out_total);
    },
    outstanding_amount: function(frm, cdt, cdn){
        let grand_total = 0
        let out_total = 0
        $.each(frm.doc['references'] || [], function(i, row) {
            grand_total += row.total_amount
            out_total += row.outstanding_amount
        });
        frm.set_value('grand_total', grand_total);
        frm.set_value('total_outstanding', out_total);
    },
    total_amount: function(frm, cdt, cdn){
        let grand_total = 0
        let out_total = 0
        $.each(frm.doc['references'] || [], function(i, row) {
            grand_total += row.total_amount
            out_total += row.outstanding_amount
        });
        frm.set_value('grand_total', grand_total);
        frm.set_value('total_outstanding', out_total);
    }
})


function get_sales_order(row, doctype, fieldname) {
	frappe.call({
		method: "frappe.client.get_value",
		args: {
			doctype: doctype,
			fieldname: fieldname,
			filters: { "name": row.reference_name }
		},
		callback: function (r) {
			if (r.message) {
				frappe.model.set_value(row.doctype, row.name, "cost_center", r.message.cost_center);
			}
		}
	});
}

