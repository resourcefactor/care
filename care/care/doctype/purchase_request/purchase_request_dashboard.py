from __future__ import unicode_literals
from frappe import _

def get_data():
    return {
        'fieldname': 'purchase_request',
        'transactions': [
            {
                'label': _('Material Demand'),
                'items': ['Material Demand']
            },
            {
                'label': _('Purchase Order'),
                'items': ['Purchase Order']
            },
            {
                'label': _('Purchase Invoice'),
                'items': ['Purchase Invoice']
            }
        ]
    }